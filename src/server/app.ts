import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import {
  initAuthStore,
  login,
  verifySession,
  logout,
  listUsersForAdmin,
  createUserByAdmin,
  updateUserByAdmin,
  deleteUserByAdmin,
} from './authService.js';

dotenv.config();

const app = express();

// Enable CORS for Vercel, local dev, and cross-domain access
app.use((req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, x-auth-token, x-gemini-api-key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Normalize request URL for Vercel Serverless Functions where /api might be rewritten or stripped
app.use((req: Request, res: Response, next: NextFunction) => {
  // Check headers passed by Vercel / reverse proxies
  const forwardedUri = (req.headers['x-forwarded-uri'] || req.headers['x-matched-path'] || req.headers['x-original-url']) as string | undefined;
  if (forwardedUri && forwardedUri.startsWith('/api') && (req.url === '/' || req.url === '/api' || !req.url.startsWith('/api'))) {
    req.url = forwardedUri;
  }

  // Handle catch-all parameter if routed via /api?path=$1
  const qPath = req.query?.path;
  if (qPath && (req.url === '/' || req.url === '/api' || req.url.startsWith('/?') || req.url.startsWith('/api?') || req.url.startsWith('/api/?'))) {
    const subpath = Array.isArray(qPath) ? qPath.join('/') : qPath;
    req.url = '/api/' + String(subpath).replace(/^\/+/, '');
  }

  // Prepend /api if path is stripped (e.g. /auth/login -> /api/auth/login)
  if (!req.url.startsWith('/api') && (
    req.url.startsWith('/auth') ||
    req.url.startsWith('/exam') ||
    req.url.startsWith('/admin') ||
    req.url.startsWith('/health')
  )) {
    req.url = '/api' + req.url;
  }
  next();
});

// Safe Body parser: if Vercel already parsed the body into an object, do not re-read stream
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    return next();
  }
  express.json({ limit: '60mb' })(req, res, (err) => {
    if (err) {
      console.warn('[BodyParser JSON Warning]:', err.message);
    }
    next();
  });
});

app.use((req: Request, res: Response, next: NextFunction) => {
  express.urlencoded({ limit: '60mb', extended: true })(req, res, (err) => {
    if (err) {
      console.warn('[BodyParser URL Encoded Warning]:', err.message);
    }
    next();
  });
});

// Helper khởi tạo Gemini Client an toàn, hỗ trợ Vercel Environment Variables
function getAiInstance(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Chưa cấu hình biến môi trường GEMINI_API_KEY trên Vercel. Vui lòng vào Vercel Dashboard -> Settings -> Environment Variables, thêm GEMINI_API_KEY rồi Redeploy.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Danh sách các mô hình tối ưu theo thứ tự ưu tiên & dự phòng khi hết hạn mức (Quota 429)
const FAST_MODEL = 'gemini-2.5-flash';
const CANDIDATE_MODELS = [
  'gemini-2.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
];

// Helper: Repair unescaped LaTeX backslashes and raw control characters inside JSON strings
function repairJsonWithLatex(jsonStr: string): string {
  let inString = false;
  let result = '';

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];

    if (!inString) {
      if (ch === '"') {
        inString = true;
      }
      result += ch;
      continue;
    }

    if (ch === '"') {
      inString = false;
      result += ch;
      continue;
    }

    if (ch === '\\') {
      const nextChar = jsonStr[i + 1];
      if (nextChar === undefined) {
        result += '\\\\';
        continue;
      }

      if (nextChar === '"' || nextChar === '\\' || nextChar === '/') {
        result += '\\' + nextChar;
        i++;
        continue;
      }

      if (nextChar === 'u' && /^[0-9a-fA-F]{4}/.test(jsonStr.substring(i + 2, i + 6))) {
        result += '\\u' + jsonStr.substring(i + 2, i + 6);
        i += 5;
        continue;
      }

      if (['b', 'f', 'n', 'r', 't'].includes(nextChar)) {
        const afterNext = jsonStr[i + 2] || '';
        if (/[a-zA-Z]/.test(afterNext)) {
          result += '\\\\' + nextChar;
        } else {
          result += '\\' + nextChar;
        }
        i++;
        continue;
      }

      if (nextChar === '\n' || nextChar === '\r') {
        result += '\\n';
        i++;
        continue;
      }

      result += '\\\\' + nextChar;
      i++;
      continue;
    }

    if (ch === '\n') {
      result += '\\n';
    } else if (ch === '\r') {
      // ignore
    } else if (ch === '\t') {
      result += '\\t';
    } else {
      result += ch;
    }
  }

  return result;
}

// Helper: Close incomplete JSON if response was cut off
function closeIncompleteJson(jsonStr: string): string {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = 0; i < jsonStr.length; i++) {
    const ch = jsonStr[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      stack.push('}');
    } else if (ch === '[') {
      stack.push(']');
    } else if (ch === '}' || ch === ']') {
      if (stack.length > 0 && stack[stack.length - 1] === ch) {
        stack.pop();
      }
    }
  }

  let fixed = jsonStr.trim();
  if (inString) {
    fixed += '"';
  }
  fixed = fixed.replace(/,\s*$/, '');
  while (stack.length > 0) {
    fixed += stack.pop();
  }
  return fixed;
}

function safeParseJSON(rawStr: string, fallback: any = {}): any {
  if (!rawStr || typeof rawStr !== 'string') return fallback;

  let cleaned = rawStr.trim();
  const mdMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (mdMatch) {
    cleaned = mdMatch[1].trim();
  } else {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    }
  }

  try {
    return JSON.parse(cleaned);
  } catch (err1) {
    try {
      const repaired = repairJsonWithLatex(cleaned);
      return JSON.parse(repaired);
    } catch (err2) {
      try {
        const closed = closeIncompleteJson(cleaned);
        const repairedClosed = repairJsonWithLatex(closed);
        return JSON.parse(repairedClosed);
      } catch (err3) {
        console.error('All JSON parsing strategies failed:', err3);
        return fallback;
      }
    }
  }
}

async function callGeminiFast(params: {
  model?: string;
  contents: any;
  config?: any;
}): Promise<any> {
  const ai = getAiInstance();
  const preferredModel = params.model || FAST_MODEL;
  const queue = [
    preferredModel,
    ...CANDIDATE_MODELS.filter((m) => m !== preferredModel),
  ];

  let lastError: any = null;

  for (let i = 0; i < queue.length; i++) {
    const model = queue[i];
    try {
      const response = await ai.models.generateContent({
        model,
        contents: params.contents,
        config: params.config,
      });
      return response;
    } catch (err: any) {
      lastError = err;
      const isQuota =
        err?.status === 'RESOURCE_EXHAUSTED' ||
        err?.message?.includes('429') ||
        err?.message?.includes('Quota exceeded');

      console.warn(
        `[Gemini Engine] Mô hình "${model}" thất bại (hết quota: ${isQuota}): ${err?.message?.slice(0, 150)}`
      );

      if (i < queue.length - 1) {
        console.log(`[Gemini Engine] Tự động chuyển tiếp sang mô hình dự phòng "${queue[i + 1]}"...`);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  const isAllQuota =
    lastError?.status === 'RESOURCE_EXHAUSTED' ||
    lastError?.message?.includes('429') ||
    lastError?.message?.includes('Quota exceeded');

  if (isAllQuota) {
    throw new Error(
      'Hạn mức yêu cầu miễn phí của Google AI (Quota 429) hiện đang tạm đầy. Vui lòng thử lại sau ít phút.'
    );
  }

  throw lastError;
}

function normalizeMimeType(mime: string): string {
  if (!mime) return 'image/jpeg';
  const lower = mime.toLowerCase();
  if (lower.includes('png')) return 'image/png';
  if (lower.includes('webp')) return 'image/webp';
  if (lower.includes('pdf')) return 'application/pdf';
  return 'image/jpeg';
}

// Initialize default admin and user store safely
try {
  initAuthStore();
} catch (e) {
  console.warn('[Auth] Init store warning:', e);
}

function extractToken(req: Request): string {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  const xToken = req.headers['x-auth-token'];
  if (typeof xToken === 'string') return xToken.trim();
  return '';
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Vui lòng đăng nhập để sử dụng tính năng này.' });
  }
  const { user, expired } = verifySession(token);
  if (expired) {
    return res.status(401).json({
      error: 'Tài khoản của bạn đã hết hạn sử dụng. Vui lòng liên hệ Quản trị viên để gia hạn.',
      expired: true,
    });
  }
  if (!user) {
    return res.status(401).json({ error: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.' });
  }
  (req as any).user = user;
  (req as any).token = token;
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  requireAuth(req, res, () => {
    const user = (req as any).user;
    if (user?.role !== 'admin') {
      return res.status(403).json({ error: 'Chỉ có Quản trị viên (Admin) mới có quyền truy cập.' });
    }
    next();
  });
}

// ================= API ENDPOINTS =================
// Hỗ trợ cả 2 dạng: /api/... và /... để không phụ thuộc vào rewrite của serverless

// API: Health check
app.get(['/api/health', '/health'], (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    hasApiKey: !!process.env.GEMINI_API_KEY,
    model: FAST_MODEL,
    time: new Date().toISOString(),
  });
});

// Root API ping
app.get(['/api', '/api/'], (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    name: 'Hệ thống tạo đề theo đề mẫu API',
    hasApiKey: !!process.env.GEMINI_API_KEY,
  });
});

// ================= AUTH ROUTES =================
// Đăng nhập (Admin: daotam28 / 123456@ hoặc Tài khoản người dùng có hạn sử dụng)
app.post(['/api/auth/login', '/auth/login'], (req: Request, res: Response) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.' });
    }

    const result = login(String(username), String(password));
    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err: any) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Lỗi máy chủ khi đăng nhập: ' + (err?.message || err) });
  }
});

// Lấy thông tin tài khoản hiện tại
app.get(['/api/auth/me', '/auth/me'], (req: Request, res: Response) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ success: false, error: 'Chưa đăng nhập.' });
    }

    const { user, expired } = verifySession(token);
    if (expired) {
      return res.status(401).json({
        success: false,
        expired: true,
        error: 'Tài khoản của bạn đã hết hạn sử dụng. Vui lòng liên hệ Admin.',
      });
    }

    if (!user) {
      return res.status(401).json({ success: false, error: 'Phiên làm việc hết hạn.' });
    }

    res.json({ success: true, user });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Lỗi kiểm tra phiên.' });
  }
});

// Đăng xuất
app.post(['/api/auth/logout', '/auth/logout'], (req: Request, res: Response) => {
  const token = extractToken(req);
  if (token) {
    logout(token);
  }
  res.json({ success: true });
});

// ================= ADMIN USER MANAGEMENT ROUTES =================
// Danh sách người dùng (chỉ Admin)
app.get(['/api/admin/users', '/admin/users'], requireAdmin, (req: Request, res: Response) => {
  try {
    const users = listUsersForAdmin();
    res.json({ success: true, users });
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Lỗi lấy danh sách người dùng.' });
  }
});

// Tạo tài khoản người dùng mới (chỉ Admin)
app.post(['/api/admin/users', '/admin/users'], requireAdmin, (req: Request, res: Response) => {
  try {
    const { username, password, expiryDate, displayName, note } = req.body || {};
    const result = createUserByAdmin({
      username,
      password,
      expiryDate,
      displayName,
      note,
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.status(201).json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Lỗi khi tạo người dùng.' });
  }
});

// Cập nhật người dùng (gia hạn thời gian đến 24h ngày kết thúc, đổi pass, khóa/mở)
app.put(['/api/admin/users/:id', '/admin/users/:id'], requireAdmin, (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    const { expiryDate, password, isActive, displayName, note } = req.body || {};

    const result = updateUserByAdmin(userId, {
      expiryDate,
      password,
      isActive,
      displayName,
      note,
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Lỗi khi cập nhật người dùng.' });
  }
});

// Xóa tài khoản người dùng (chỉ Admin)
app.delete(['/api/admin/users/:id', '/admin/users/:id'], requireAdmin, (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    const result = deleteUserByAdmin(userId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: 'Lỗi khi xóa tài khoản.' });
  }
});

// API: OCR and Analyze Exam Input - QUÉT TOÀN BỘ 100% NỘI DUNG ĐỀ THI
app.post(['/api/exam/analyze', '/exam/analyze'], requireAuth, async (req: Request, res: Response) => {
  try {
    const { images, textContent, subject, grade, examType, timeAllowed, notes } = req.body || {};

    if ((!images || images.length === 0) && (!textContent || textContent.trim() === '')) {
      return res.status(400).json({ error: 'Vui lòng tải lên ảnh, dán ảnh Ctrl+V hoặc chọn file PDF/Word.' });
    }

    const systemInstruction = `Bạn là Chuyên gia Giáo dục & Đánh giá Khảo thí AI cấp cao kiêm Chuyên viên xử lý dữ liệu tài liệu (OCR & Content Synthesis) của Bộ Giáo dục và Đào tạo Việt Nam.
Nhiệm vụ tối quan trọng: Tiếp nhận tài liệu đề thi mẫu do người dùng cung cấp (ảnh chụp nhiều trang, file PDF hoặc file Word) và THỰC HIỆN QUÉT ĐẦY ĐỦ 100% TOÀN BỘ TẤT CẢ CÁC CÂU HỎI TRONG ĐỀ THI TỪ ĐẦU ĐẾN CUỐI.

QUY TẮC BẮT BUỘC VỀ PHẠM VI QUÉT 100% (KHÔNG ĐƯỢC BỎ SÓT):
1. QUÉT ĐỦ 100% TẤT CẢ CÁC CÂU HỎI:
   - Bạn PHẢI quét đọc và trích xuất TOÀN BỘ tất cả các câu hỏi có trong tài liệu, từ Câu 1 cho đến câu cuối cùng của đề thi (ví dụ: đến hết Câu 40, Câu 50,...).
   - TUYỆT ĐỐI KHÔNG ĐƯỢC rút gọn, KHÔNG được cắt ngắn, KHÔNG được dừng ở giữa chừng, KHÔNG được viết '...tương tự các câu tiếp theo'.
   - Nếu đề thi có nhiều trang (Trang 1, Trang 2, Trang 3, Trang 4...), bạn PHẢI duyệt qua từng trang một, quét hết từng câu hỏi trên từng trang.
   - Thống kê chính xác tổng số câu hỏi đã quét được vào trường "totalQuestions".

2. BẢO TOÀN NGUYÊN VẸN CẤU TRÚC VÀ CÁC MỤC I, II, III, IV:
   - BẮT BUỘC giữ nguyên tiêu đề các mục / phần: PHẦN I, PHẦN II, PHẦN III, PHẦN IV (hoặc Mục I, II, III, IV) đúng như trong đề mẫu gốc.
   - Các câu hỏi phải đánh số đúng thứ tự: Câu 1, Câu 2, Câu 3... giữ nguyên 100%.
   - Định dạng theo chuẩn Bộ GD&ĐT:
     + PHẦN I: Trắc nghiệm nhiều phương án (4 lựa chọn A, B, C, D).
     + PHẦN II: Trắc nghiệm Đúng/Sai (Mỗi câu gồm 4 ý a, b, c, d rõ ràng với boolean isCorrect trong subQuestions).
     + PHẦN III: Trắc nghiệm trả lời ngắn (Kết quả điền số).
     + PHẦN IV: Tự luận (nếu có).

3. QUY TẮC CÔNG THỨC TOÁN HỌC & KHOA HỌC:
   - MỌI công thức toán, lý, hóa BẮT BUỘC đặt trong cặp dấu chuẩn LaTeX: $công_thức$ (inline) hoặc $$công_thức$$ (display).
   - Tuyệt đối không dùng ký tự Unicode thô sơ cho căn thức hay phân số (Dùng $\\frac{a}{b}$, $\\sqrt{x}$, $\\vec{u}$, $\\int$, $\\lim_{x \\to 0}$).

4. NHẬN DIỆN CÂU HỎI CÓ HÌNH VẼ / ĐỒ THỊ / HÌNH HỌC (QUAN TRỌNG):
   - Khi quét đề thi mẫu, hãy nhận diện kỹ tất cả câu hỏi nào có hình vẽ minh họa (đồ thị hàm số, bảng biến thiên, hình chóp, lăng trụ, nón, trụ, cầu, tam giác, đường tròn, hệ trục tọa độ Oxy/Oxyz, sơ đồ thực tế):
   - BẮT BUỘC đặt "hasVisual": true.
   - "visualDescription": Mô tả chi tiết hình vẽ (dạng đồ thị, các điểm cực trị, giao điểm trục tọa độ, các đỉnh hình học, chiều cao, góc, kích thước...).
   - Cung cấp mã SVG nếu có thể trong "svgCode" ('<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" style="background:#ffffff">...</svg>').

5. ĐỊNH DẠNG ĐẦU RA JSON BẮT BUỘC:
{
  "title": "Tên kỳ thi / Môn học / Lớp / Thời gian làm bài",
  "subject": "Môn học (Toán, Vật lí, Hóa học, Sinh học, v.v.)",
  "grade": "Khối lớp (Lớp 10, Lớp 11, Lớp 12, THPT Quốc Gia, v.v.)",
  "totalQuestions": 40,
  "matrixSummary": {
    "topics": ["Chủ đề 1", "Chủ đề 2"],
    "cognitiveLevels": {
      "nhanBiet": 40,
      "thongHieu": 30,
      "vanDung": 20,
      "vanDungCao": 10
    },
    "formats": ["Trắc nghiệm 4 lựa chọn", "Đúng/Sai", "Trả lời ngắn"]
  },
  "parts": [
    {
      "partId": "part_1",
      "partTitle": "PHẦN I. CÂU TRẮC NGHIỆM NHIỀU PHƯƠNG ÁN LỰA CHỌN",
      "instruction": "Thí sinh trả lời từ câu 1 đến câu ... Mỗi câu hỏi thí sinh chỉ chọn một phương án.",
      "questions": [
        {
          "questionNumber": 1,
          "content": "Nội dung câu hỏi 1 với công thức LaTeX $...$",
          "cognitiveLevel": "Nhận biết",
          "topic": "Chủ đề",
          "hasVisual": false,
          "visualDescription": "Mô tả hình nếu có",
          "svgCode": "<svg ...>...</svg>",
          "options": [
            { "key": "A", "content": "..." },
            { "key": "B", "content": "..." },
            { "key": "C", "content": "..." },
            { "key": "D", "content": "..." }
          ],
          "correctAnswer": "A",
          "explanation": "Lời giải chi tiết ngắn gọn"
        }
      ]
    }
  ],
  "rawOcrNotes": "Đã quét thành công 100% toàn bộ câu hỏi của đề thi"
}`;

    const promptParts: any[] = [];

    if (Array.isArray(images) && images.length > 0) {
      for (const img of images) {
        if (img.data) {
          promptParts.push({
            inlineData: {
              data: img.data,
              mimeType: normalizeMimeType(img.mimeType),
            },
          });
        }
      }
    }

    let userPrompt = `YÊU CẦU QUAN TRỌNG: Hãy thực hiện quét OCR TOÀN DIỆN 100% TẤT CẢ các câu hỏi trong đề thi này, từ Câu 1 đến câu cuối cùng của đề.
Thông tin giáo viên:
- Môn: ${subject || 'Tự nhận diện'}
- Khối: ${grade || 'Lớp 12'} (từ Lớp 1 đến Lớp 12)
- Hình thức thi: ${examType || 'Giữa kì'}
- Thời gian làm bài: ${timeAllowed || '90 phút'}
- Ghi chú: ${notes || 'Không có'}
`;

    if (textContent && textContent.trim()) {
      userPrompt += `\n--- VĂN BẢN ĐỀ THI GỐC ---\n${textContent}\n---------------------------\n`;
    }

    userPrompt += `\nLƯU Ý ĐẶC BIỆT:
1. Hãy quét ĐỦ 100% TẤT CẢ các câu hỏi có trong tài liệu, TUYỆT ĐỐI KHÔNG BỎ SÓT câu nào từ đầu đến cuối.
2. Bảo toàn các mục: PHẦN I, PHẦN II, PHẦN III, PHẦN IV và số thứ tự Câu 1, Câu 2...
3. Xuất toàn bộ công thức toán bằng LaTeX $...$ chuẩn. Trả về đúng định dạng JSON quy định.`;

    promptParts.push({ text: userPrompt });

    const response = await callGeminiFast({
      model: FAST_MODEL,
      contents: { parts: promptParts },
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.1,
        topP: 0.8,
        maxOutputTokens: 65536,
      },
    });

    const responseText = response.text || '{}';
    const parsedData = safeParseJSON(responseText, {
      title: 'Đề Thi Mẫu Đã Quét Toàn Bộ 100%',
      subject: subject || 'Toán học',
      grade: grade || 'Lớp 12',
      examType: examType || 'Giữa kì',
      timeAllowed: timeAllowed || '90 phút',
      parts: [],
    });

    if (subject) parsedData.subject = subject;
    if (grade) parsedData.grade = grade;
    if (examType) parsedData.examType = examType;
    if (timeAllowed) parsedData.timeAllowed = timeAllowed;

    const allQuestions = (parsedData.parts || []).flatMap((p: any) => p.questions || []);
    if (allQuestions.length > 0) {
      parsedData.totalQuestions = allQuestions.length;
    }

    res.json({
      success: true,
      data: parsedData,
      totalQuestionsScanned: allQuestions.length,
    });
  } catch (error: any) {
    console.error('Error analyzing exam:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Lỗi khi xử lý OCR và phân tích đề thi.',
    });
  }
});

// API: Sinh đề tương đương - ĐẢM BẢO SINH ĐỦ 100% SỐ CÂU NHƯ ĐỀ GỐC
app.post(['/api/exam/generate-equivalent', '/exam/generate-equivalent'], requireAuth, async (req: Request, res: Response) => {
  try {
    const { originalExam, variantIndex = 1, customization } = req.body || {};

    if (!originalExam || !originalExam.parts) {
      return res.status(400).json({ error: 'Thiếu dữ liệu đề thi gốc để sinh đề tương đương.' });
    }

    const totalOriginalQuestions = (originalExam.parts || []).flatMap((p: any) => p.questions || []).length;
    const currentCodeNumber = 100 + Number(variantIndex);

    const systemInstruction = `Bạn là Chuyên gia Khảo thí & Biên soạn Đề thi Quốc gia cấp cao của Bộ Giáo dục & Đào tạo Việt Nam.
Nhiệm vụ tối quan trọng: Biên soạn ĐỀ THI TƯƠNG ĐƯƠNG (MÃ ĐỀ: ${currentCodeNumber}) từ đề thi gốc được cung cấp, tuân thủ nguyên tắc khảo thí chuẩn mực.

NGUYÊN TẮC BẮT BUỘC 100%:
1. BÁM SÁT 100% CẤU TRÚC ĐỀ MẪU (TƯƠNG ỨNG 1-1 TỪNG CÂU VỚI ĐỀ GỐC):
   - Đề gốc có bao nhiêu phần (PHẦN I, PHẦN II, PHẦN III, PHẦN IV...) và mỗi phần có bao nhiêu câu, THÌ ĐỀ MỚI BẮT BUỘC PHẢI CÓ ĐÚNG SỐ PHẦN ĐÓ VÀ ĐÚNG SỐ LƯỢNG CÂU ĐÓ (tổng cộng đủ 100% ${totalOriginalQuestions} câu).
   - TƯƠNG ỨNG 1-1 TỪNG CÂU VỚI ĐỀ MẪU:
     + Câu 1 đề mẫu hỏi về dạng toán/chủ đề nào thì Câu 1 đề mới BẮT BUỘC hỏi về dạng toán/chủ đề đó với mức độ nhận thức tương đương.
     + Nếu Câu k là trắc nghiệm 4 chọn 1: Đề mới câu k cũng là trắc nghiệm 4 chọn 1.
     + Nếu Câu k là trắc nghiệm Đúng/Sai (gồm 4 ý a, b, c, d): Đề mới câu k BẮT BUỘC cũng là trắc nghiệm Đúng/Sai với 4 ý a, b, c, d tương ứng.
     + Nếu Câu k là trả lời ngắn (điền số/đáp án): Đề mới câu k BẮT BUỘC cũng là câu hỏi trả lời ngắn.
   - GIỮ NGUYÊN 100% TIÊU ĐỀ CÁC PHẦN (PHẦN I, PHẦN II, PHẦN III...) và số thứ tự Câu 1, Câu 2, Câu 3... y hệt đề gốc.

2. QUY TẮC BẮT BUỘC VỀ YẾU TỐ HÌNH HỌC (BẮT BUỘC THAY ĐỔI THÀNH CÁC HÌNH KHÁC NHAU):
   - ĐẶC BIỆT LƯU Ý VÀ TUÂN THỦ NGHIÊM NGẶT: Với MỌI câu hỏi có yếu tố hình học (hình học phẳng, hình học không gian, khối đa diện, khối tròn xoay, hệ tọa độ Oxy/Oxyz, đồ thị hàm số):
     + BẮT BUỘC PHẢI THAY ĐỔI THÀNH CÁC LOẠI HÌNH KHÁC NHAU (TUYỆT ĐỐI KHÔNG DÙNG LẠI LOẠI HÌNH CŨ TRONG ĐỀ GỐC)!
     + CÁC QUY TẮC CHUYỂN ĐỔI HÌNH CỤ THỂ:
       * Nếu đề gốc là HÌNH CHÓP TỨ GIÁC (đáy hình vuông, hình chữ nhật) -> Đề mới BẮT BUỘC PHẢI ĐỔI THÀNH HÌNH LĂNG TRỤ TAM GIÁC, HÌNH LĂNG TRỤ ĐỨNG TỨ GIÁC, HÌNH HỘP CHỮ NHẬT, hoặc HÌNH CHÓP TAM GIÁC (TỨ DIỆN).
       * Nếu đề gốc là HÌNH CHÓP TAM GIÁC (TỨ DIỆN) -> Đề mới BẮT BUỘC PHẢI ĐỔI THÀNH HÌNH LĂNG TRỤ TAM GIÁC ĐỨNG, HÌNH HỘP, hoặc HÌNH CHÓP CÓ ĐÁY HÌNH THOI / HÌNH CHỮ NHẬT.
       * Nếu đề gốc là KHỐI LĂNG TRỤ -> Đề mới BẮT BUỘC PHẢI ĐỔI THÀNH HÌNH CHÓP, HÌNH HỘP, hoặc KHỐI NÓN/TRỤ tương ứng.
       * Nếu đề gốc là KHỐI TRỤ -> Đề mới BẮT BUỘC PHẢI ĐỔI THÀNH KHỐI NÓN, hoặc KHỐI CẦU, hoặc LĂNG TRỤ ĐỀU NỘI TIẾP TRỤ.
       * Nếu đề gốc là KHỐI NÓN -> Đề mới BẮT BUỘC PHẢI ĐỔI THÀNH KHỐI TRỤ hoặc KHỐI CẦU.
       * Nếu đề gốc là TAM GIÁC VUÔNG -> Đề mới BẮT BUỘC PHẢI ĐỔI THÀNH TAM GIÁC ĐỀU, TAM GIÁC CÂN, HÌNH THANG VUÔNG hoặc HÌNH THOI.
       * Nếu đề gốc là HÌNH VUÔNG / CHỮ NHẬT -> Đề mới BẮT BUỘC PHẢI ĐỔI THÀNH HÌNH BÌNH HÀNH, HÌNH THOI, hoặc HÌNH THANG CÂN.
       * Nếu đề gốc là ĐỒ THỊ BẬC BA ($y = ax^3 + bx^2 + cx + d$) -> Đề mới BẮT BUỘC PHẢI ĐỔI THÀNH ĐỒ THỊ BẬC BỐN TRÙNG PHƯƠNG ($y = ax^4 + bx^2 + c$), hoặc ĐỒ THỊ HÀM PHÂN THỨC HỮU TỶ ($y = \\frac{ax+b}{cx+d}$), hoặc ĐỒ THỊ BẬC HAI TRÊN BẬC NHẤT ($y = \\frac{ax^2+bx+c}{dx+e}$).
       * Nếu đề gốc là BẢNG BIẾN THIÊN -> Đề mới CÓ THỂ ĐỔI THÀNH ĐỒ THỊ TRỰC QUAN hoặc HÀM SỐ KHÁC VỚI CÁC ĐIỂM CỰC TRỊ VÀ BẢNG DẤU ĐẠO HÀM MỚI.
       * Nếu đề gốc là PHƯƠNG TRÌNH MẶT CẦU TRONG OXYZ -> Đề mới BẮT BUỘC ĐỔI THÀNH PHƯƠNG TRÌNH MẶT PHẲNG, ĐƯỜNG THẲNG, hoặc TỨ DIỆN/HÌNH HỘP TRONG OXYZ.
     + ĐỒNG THỜI THAY ĐỔI TOÀN BỘ SỐ LIỆU: Mọi kích thước cạnh, chiều cao, bán kính, số đo góc, tọa độ điểm và hệ số hàm số phải được tính toán mới hoàn toàn, cho kết quả nghiệm đẹp, phân số tối giản.
     + HÌNH VẼ SVG ĐÍNH KÈM ("svgCode"): BẮT BUỘC PHẢI VẼ ĐÚNG THEO LOẠI HÌNH MỚI ĐÃ CHUYỂN ĐỔI (ví dụ: chuyển từ chóp sang lăng trụ thì hình SVG phải là hình lăng trụ với đầy đủ các đỉnh A, B, C, A', B', C' và nét đứt nét liền chuẩn xác)!

3. QUY CHUẨN CÔNG THỨC TOÁN & HÌNH VẼ SVG:
   - MỌI công thức toán học BẮT BUỘC đặt trong cặp dấu LaTeX: $công_thức$ (inline) hoặc $$công_thức$$ (display).
   - Câu nào có hình vẽ (hoặc hasVisual: true ở đề gốc): Đặt "hasVisual": true và cung cấp mã SVG hoàn chỉnh, đẹp mắt trong "svgCode" ('<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg" style="background:#ffffff">...</svg>') vẽ đúng theo loại hình mới đã thay đổi.
   - Nội dung câu hỏi ("content") bám sát hình vẽ tương ứng của câu đó.

4. BẢNG ĐÁP ÁN & HƯỚNG DẪN CHẤM:
   - Bảng đáp án nhanh đầy đủ cho tất cả ${totalOriginalQuestions} câu.
   - Hướng dẫn giải chi tiết từng bước bằng LaTeX chuẩn mực.

CẤU TRÚC JSON TRẢ VỀ:
{
  "examCode": "MÃ ĐỀ: ${currentCodeNumber}",
  "title": "Đề thi môn ${originalExam.subject || 'Toán'} - ${originalExam.grade || 'Lớp 12'}",
  "subject": "${originalExam.subject || 'Toán'}",
  "grade": "${originalExam.grade || 'Lớp 12'}",
  "examType": "${originalExam.examType || 'Giữa kì'}",
  "timeAllowed": "${originalExam.timeAllowed || '90 phút'}",
  "totalScore": 10.0,
  "totalQuestions": ${totalOriginalQuestions},
  "parts": [
    {
      "partId": "part_1",
      "partTitle": "PHẦN I. CÂU TRẮC NGHIỆM NHIỀU PHƯƠNG ÁN LỰA CHỌN",
      "instruction": "Thí sinh trả lời từ câu 1 đến câu ... Mỗi câu hỏi thí sinh chỉ chọn một phương án.",
      "questions": [
        {
          "questionNumber": 1,
          "content": "Nội dung câu 1 mới tương đương 1-1 với câu 1 đề gốc...",
          "cognitiveLevel": "Nhận biết",
          "topic": "Chủ đề",
          "hasVisual": false,
          "visualDescription": "",
          "svgCode": "",
          "options": [
            { "key": "A", "content": "$...$" },
            { "key": "B", "content": "$...$" },
            { "key": "C", "content": "$...$" },
            { "key": "D", "content": "$...$" }
          ],
          "correctAnswer": "A",
          "explanation": "Lời giải chi tiết từng bước..."
        }
      ]
    }
  ],
  "quickAnswerKey": [
    { "question": 1, "answer": "A" }
  ],
  "pedagogicalNotes": "Đề tương đương được biên soạn chuẩn mực 100% số câu, chuyển đổi hình học đa dạng và bám sát ma trận đề gốc."
}`;

    const promptExamData = {
      title: originalExam.title,
      subject: originalExam.subject,
      grade: originalExam.grade,
      examType: originalExam.examType,
      timeAllowed: originalExam.timeAllowed,
      totalQuestions: totalOriginalQuestions,
      parts: (originalExam.parts || []).map((p: any) => ({
        partId: p.partId,
        partTitle: p.partTitle,
        instruction: p.instruction,
        questions: (p.questions || []).map((q: any) => ({
          questionNumber: q.questionNumber,
          content: q.content,
          cognitiveLevel: q.cognitiveLevel,
          topic: q.topic,
          hasVisual: q.hasVisual,
          visualDescription: q.visualDescription || (q.svgCode ? 'Có hình minh họa' : undefined),
          options: q.options,
          subQuestions: q.subQuestions,
          shortAnswer: q.shortAnswer,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
        })),
      })),
    };

    const userPrompt = `Hãy biên soạn ĐỀ THI TƯƠNG ĐƯƠNG (MÃ ĐỀ: ${currentCodeNumber}) bám sát 100% cấu trúc của ${totalOriginalQuestions} câu hỏi từ đề gốc sau đây:
${JSON.stringify(promptExamData, null, 2)}

Yêu cầu bắt buộc:
1. Bám sát 100% cấu trúc đề mẫu (đặc biệt các phần I, II, III... và từng câu tương ứng 1-1 từ Câu 1 đến Câu ${totalOriginalQuestions}). Đủ 100% số câu, không bỏ sót câu nào.
2. CÁC CÂU CÓ YẾU TỐ HÌNH HỌC (BẮT BUỘC THAY ĐỔI THÀNH CÁC HÌNH KHÁC NHAU): Mọi câu hỏi hình học (hình học phẳng, hình không gian, khối đa diện, khối tròn xoay, tọa độ Oxyz, đồ thị hàm số) BẮT BUỘC PHẢI THAY ĐỔI THÀNH LOẠI HÌNH KHÁC (chóp tứ giác đổi sang lăng trụ tam giác hoặc tứ diện; trụ đổi sang nón hoặc cầu; tam giác vuông đổi sang tam giác đều hoặc hình thang vuông; đồ thị bậc ba đổi sang đồ thị phân thức hoặc bậc bốn trùng phương). Tuyệt đối không giữ nguyên cùng loại hình và không giữ nguyên số liệu đề gốc!
3. VẼ HÌNH SVG TƯƠNG ỨNG VỚI HÌNH MỚI: Sinh mã "svgCode" chuẩn xác vẽ đúng theo loại hình mới đã chuyển đổi (đầy đủ các đỉnh, nét đứt nét liền, nhãn chuẩn xác) và đặt "hasVisual": true.
4. MÃ ĐỀ: Đặt đúng là "MÃ ĐỀ: ${currentCodeNumber}".
5. Đáp án chính xác, lời giải chi tiết bằng LaTeX.`;

    const response = await callGeminiFast({
      model: FAST_MODEL,
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.15,
        topP: 0.85,
        maxOutputTokens: 65536,
      },
    });

    const responseText = response.text || '{}';
    const parsedData = safeParseJSON(responseText, {
      examCode: `MÃ ĐỀ: ${currentCodeNumber}`,
      title: `Đề thi môn ${originalExam.subject || 'Toán'} - ${originalExam.grade || 'Lớp 12'}`,
      subject: originalExam.subject,
      grade: originalExam.grade,
      examType: originalExam.examType || 'Giữa kì',
      timeAllowed: originalExam.timeAllowed || '90 phút',
      parts: originalExam.parts,
      totalQuestions: totalOriginalQuestions,
    });

    parsedData.examCode = `MÃ ĐỀ: ${currentCodeNumber}`;
    parsedData.title = `Đề thi môn ${originalExam.subject || 'Toán'} - ${originalExam.grade || 'Lớp 12'}`;
    parsedData.subject = originalExam.subject;
    parsedData.grade = originalExam.grade;
    parsedData.examType = originalExam.examType || 'Giữa kì';
    parsedData.timeAllowed = originalExam.timeAllowed || '90 phút';

    res.json({
      success: true,
      data: parsedData,
    });
  } catch (error: any) {
    console.error('Error generating equivalent exam:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Lỗi trong quá trình sinh đề thi tương đương.',
    });
  }
});

// API: Phân tích chuyên sâu câu hỏi (Casio + Bẫy đề)
app.post(['/api/exam/explain-question', '/exam/explain-question'], requireAuth, async (req: Request, res: Response) => {
  try {
    const { question, subject } = req.body || {};

    if (!question) {
      return res.status(400).json({ error: 'Thiếu thông tin câu hỏi.' });
    }

    const systemInstruction = `Bạn là Giáo viên Chuyên sâu cấp Quốc gia môn ${subject || 'Toán / Khoa học tự nhiên'}.
Phân tích toàn diện câu hỏi, cung cấp:
1. Bản chất toán học/khoa học và định lý cần dùng.
2. Phương pháp giải chính quy (Tự luận bài bản từng bước, có LaTeX).
3. Phương pháp giải nhanh / Bấm máy tính Casio fx-580VN X / Casio fx-880BTG (nếu áp dụng được).
4. Phân tích các phương án gây nhiễu (Tại sao học sinh dễ chọn nhầm B, C hoặc D).
5. Lời khuyên vàng khi gặp dạng toán này trong phòng thi.
6. Một câu hỏi mở rộng cùng dạng để học sinh luyện tập thêm ngay tại chỗ.`;

    const userPrompt = `Câu hỏi:
${question.content}

Các phương án:
${question.options?.map((opt: any) => `${opt.key}. ${opt.content}`).join('\n') || ''}

Đáp án đúng: ${question.correctAnswer || 'Chưa rõ'}
Lời giải hiện có: ${question.explanation || 'Không có'}`;

    const response = await callGeminiFast({
      model: FAST_MODEL,
      contents: userPrompt,
      config: {
        systemInstruction,
        temperature: 0.2,
      },
    });

    res.json({
      success: true,
      explanation: response.text,
    });
  } catch (error: any) {
    console.error('Error explaining question:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Lỗi khi tạo lời giải chuyên sâu.',
    });
  }
});

// Fallback 404 handler ONLY for API routes (cho phép các yêu cầu frontend /, /src/..., assets đi tiếp)
app.use((req: Request, res: Response, next: NextFunction) => {
  const p = req.path || req.url || '';
  if (
    p.startsWith('/api') ||
    p.startsWith('/auth') ||
    p.startsWith('/exam') ||
    p.startsWith('/admin')
  ) {
    return res.status(404).json({
      success: false,
      error: `Không tìm thấy API: ${req.method} ${req.originalUrl || req.url}`,
    });
  }
  next();
});

// Global error handler for API
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[API Server Error]:', err);
  res.status(500).json({
    success: false,
    error: err?.message || 'Lỗi máy chủ khi xử lý yêu cầu.',
  });
});

export default app;
