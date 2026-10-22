import React, { useState, useRef, useEffect } from 'react';
import { ExamData } from '../types/exam';
import mammoth from 'mammoth';
import { authFetch } from '../utils/apiClient';
import {
  Upload,
  Image as ImageIcon,
  FileType,
  X,
  Sparkles,
  AlertCircle,
  Loader2,
  Trash2,
  ClipboardPaste,
  FileCheck,
  CheckCircle2,
} from 'lucide-react';

interface ExamInputModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAnalyzeSuccess: (exam: ExamData, requestedCount?: number) => void;
}

export const ExamInputModal: React.FC<ExamInputModalProps> = ({
  isOpen,
  onClose,
  onAnalyzeSuccess,
}) => {
  // Chỉ 2 dạng đưa đề lên:
  // 1. Ảnh (Tải lên hoặc Dán ảnh Ctrl+V)
  // 2. File PDF hoặc File Word
  const [uploadMode, setUploadMode] = useState<'image' | 'document'>('image');

  // Thêm phần: Số lượng đề cần tạo (mặc định 1, giáo viên có thể chọn 1, 2, 3, 4 hoặc tự nhập)
  const [variantCount, setVariantCount] = useState<number>(1);

  // Môn học, Khối lớp (1-12), Hình thức thi & Thời gian làm bài
  const [subject, setSubject] = useState<string>('Toán học');
  const [grade, setGrade] = useState<string>('Lớp 12');
  const [examType, setExamType] = useState<string>('Giữa kì');
  const [timeAllowed, setTimeAllowed] = useState<string>('90 phút');
  const [isCustomSubject, setIsCustomSubject] = useState<boolean>(false);
  const [customSubjectText, setCustomSubjectText] = useState<string>('');

  // Dạng 1: Ảnh
  const [uploadedImages, setUploadedImages] = useState<Array<{ mimeType: string; data: string; name: string }>>([]);

  // Dạng 2: Document (PDF hoặc Word)
  const [documentFile, setDocumentFile] = useState<{
    name: string;
    type: 'pdf' | 'word';
    size: string;
    pdfData?: { mimeType: string; data: string };
    extractedText?: string;
  } | null>(null);

  const [loading, setLoading] = useState<boolean>(false);
  const [loadingStep, setLoadingStep] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  // Lắng nghe sự kiện Dán ảnh (Ctrl + V) toàn cục khi mở modal
  useEffect(() => {
    if (!isOpen) return;

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              const matches = result.match(/^data:(.+);base64,(.+)$/);
              if (matches) {
                setUploadedImages((prev) => [
                  ...prev,
                  {
                    mimeType: matches[1],
                    data: matches[2],
                    name: `Ảnh dán ${prev.length + 1} (${new Date().toLocaleTimeString('vi-VN')})`,
                  },
                ]);
                setUploadMode('image');
                setPasteNotice('Đã dán ảnh từ Clipboard thành công!');
                setTimeout(() => setPasteNotice(null), 3000);
              }
            };
            reader.readAsDataURL(file);
          }
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('paste', handlePaste);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  // Xử lý tải ảnh từ file máy tính
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const matches = result.match(/^data:(.+);base64,(.+)$/);
        if (matches) {
          setUploadedImages((prev) => [
            ...prev,
            {
              mimeType: matches[1],
              data: matches[2],
              name: file.name,
            },
          ]);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  // Nút chủ động dán ảnh từ Clipboard bằng Clipboard API
  const handlePasteFromClipboardBtn = async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        alert('Trình duyệt chưa hỗ trợ bấm nút này. Bạn chỉ cần nhấn phím tắt Ctrl + V là ảnh sẽ tự dán vào nhé!');
        return;
      }
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find((type) => type.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            const matches = result.match(/^data:(.+);base64,(.+)$/);
            if (matches) {
              setUploadedImages((prev) => [
                ...prev,
                {
                  mimeType: matches[1],
                  data: matches[2],
                  name: `Ảnh dán ${prev.length + 1} (${new Date().toLocaleTimeString('vi-VN')})`,
                },
              ]);
              setPasteNotice('Đã dán ảnh từ Clipboard thành công!');
              setTimeout(() => setPasteNotice(null), 3000);
            }
          };
          reader.readAsDataURL(blob);
          return;
        }
      }
      alert('Không tìm thấy ảnh trong Clipboard. Bạn hãy dùng phím tắt Win + Shift + S chụp ảnh đề bài trước rồi thử lại nhé!');
    } catch (e: any) {
      alert('Hãy nhấn trực tiếp phím tắt Ctrl + V trên bàn phím để dán ảnh chụp màn hình vào đây!');
    }
  };

  // Xử lý tải file PDF hoặc Word
  const handleDocumentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);
    const sizeStr = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith('.pdf')) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const matches = result.match(/^data:(.+);base64,(.+)$/);
        if (matches) {
          setDocumentFile({
            name: file.name,
            type: 'pdf',
            size: sizeStr,
            pdfData: {
              mimeType: 'application/pdf',
              data: matches[2],
            },
          });
        }
      };
      reader.readAsDataURL(file);
    } else if (fileName.endsWith('.docx') || fileName.endsWith('.doc')) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        setDocumentFile({
          name: file.name,
          type: 'word',
          size: sizeStr,
          extractedText: result.value,
        });
      } catch (err: any) {
        setError('Lỗi khi đọc file Word: ' + (err.message || 'Định dạng không hợp lệ'));
      }
    } else {
      setError('Vui lòng chọn file đúng đuôi: .pdf, .docx hoặc .doc');
    }
  };

  // Bắt đầu xử lý OCR đề gốc & Chuẩn bị sinh số lượng đề phát triển
  const handleProcessExam = async () => {
    setError(null);

    const hasImages = uploadMode === 'image' && uploadedImages.length > 0;
    const hasDoc = uploadMode === 'document' && !!documentFile;

    if (!hasImages && !hasDoc) {
      setError(
        uploadMode === 'image'
          ? 'Vui lòng chọn ảnh chụp đề thi hoặc bấm Ctrl + V để dán ảnh chụp màn hình.'
          : 'Vui lòng chọn file PDF hoặc file Word (.docx) đề thi.'
      );
      return;
    }

    setLoading(true);
    setLoadingStep('Đang quét toàn diện 100% nội dung tài liệu từ Câu 1 đến câu cuối...');

    const timer1 = setTimeout(() => {
      setLoadingStep('Đang quét 100% tất cả các câu hỏi, bóc tách công thức LaTeX và bảo toàn các phần I, II, III, IV...');
    }, 2500);

    const timer2 = setTimeout(() => {
      setLoadingStep('Đang phân tích ma trận kiến thức và chuẩn bị sinh ' + variantCount + ' đề phát triển tương đương 100%...');
    }, 5500);

    try {
      let payloadImages: any[] = [];
      let payloadText = '';

      if (uploadMode === 'image') {
        payloadImages = uploadedImages;
      } else if (documentFile) {
        if (documentFile.type === 'pdf' && documentFile.pdfData) {
          payloadImages = [documentFile.pdfData];
        } else if (documentFile.type === 'word' && documentFile.extractedText) {
          payloadText = documentFile.extractedText;
        }
      }

      const effectiveSubject = isCustomSubject && customSubjectText.trim() ? customSubjectText.trim() : subject;

      const res = await authFetch('/api/exam/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: payloadImages,
          textContent: payloadText,
          subject: effectiveSubject,
          grade,
          examType,
          timeAllowed,
          notes: 'Quét 100% toàn bộ câu hỏi từ Câu 1 đến câu cuối cùng của đề thi mẫu.',
        }),
      });

      const json = await res.json();
      if (json.success && json.data) {
        // Gán chắc chắn tiêu đề theo định dạng: Đề thi môn ... - Lớp ...
        const finalizedData = {
          ...json.data,
          title: `Đề thi môn ${effectiveSubject} - ${grade}`,
          subject: json.data.subject || effectiveSubject,
          grade: grade,
          examType: examType,
          timeAllowed: timeAllowed,
        };
        onAnalyzeSuccess(finalizedData, variantCount);
        onClose();
      } else {
        setError(json.error || 'Lỗi khi phân tích đề thi.');
      }
    } catch (err: any) {
      setError(err.message || 'Lỗi kết nối máy chủ khảo thí.');
    } finally {
      clearTimeout(timer1);
      clearTimeout(timer2);
      setLoading(false);
      setLoadingStep('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="relative w-full max-w-xl rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden my-6 flex flex-col max-h-[92vh]">
        {/* Header Đơn Giản */}
        <div className="flex items-center justify-between border-b border-slate-100 bg-blue-600 px-6 py-4 text-white shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/20 text-white backdrop-blur-xs">
              <Upload className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Đưa Đề Thi Mẫu Lên</h3>
              <p className="text-xs text-blue-100">
                Hỗ trợ <strong>Dán ảnh (Ctrl+V)</strong>, <strong>Tải ảnh</strong> hoặc <strong>File PDF / Word</strong>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-blue-100 hover:bg-white/10 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Thông báo dán ảnh thành công */}
        {pasteNotice && (
          <div className="bg-emerald-500 text-white text-xs font-bold py-1.5 px-4 text-center flex items-center justify-center gap-2 animate-fadeIn">
            <CheckCircle2 className="h-4 w-4" />
            <span>{pasteNotice}</span>
          </div>
        )}

        {/* 2 Lựa chọn đơn giản: Dạng Ảnh vs Dạng File PDF/Word */}
        <div className="grid grid-cols-2 border-b border-slate-200 bg-slate-50 p-2 gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setUploadMode('image')}
            className={`flex items-center justify-center gap-2 rounded-xl py-2.5 px-3 text-xs font-bold transition-all ${
              uploadMode === 'image'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
            }`}
          >
            <ImageIcon className="h-4 w-4" />
            <span>Dạng Ảnh (Tải hoặc Dán ảnh Ctrl+V)</span>
          </button>

          <button
            type="button"
            onClick={() => setUploadMode('document')}
            className={`flex items-center justify-center gap-2 rounded-xl py-2.5 px-3 text-xs font-bold transition-all ${
              uploadMode === 'document'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
            }`}
          >
            <FileType className="h-4 w-4" />
            <span>Dạng File PDF hoặc File Word</span>
          </button>
        </div>

        {/* Thân giao diện */}
        <div className="p-6 overflow-y-auto space-y-5 flex-1">
          {/* Cài đặt cấu hình đề thi: Khối lớp và Môn học */}
          <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
            <div className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
              <span>Cấu Hình Đề Thi</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Khối lớp: Chỉ để các lớp 1 đến 12 không ghi bất kì thông tin khác */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Khối Lớp: <span className="text-blue-600 font-extrabold">{grade}</span>
                </label>
                <select
                  value={grade}
                  onChange={(e) => setGrade(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                >
                  <option value="Lớp 1">Lớp 1</option>
                  <option value="Lớp 2">Lớp 2</option>
                  <option value="Lớp 3">Lớp 3</option>
                  <option value="Lớp 4">Lớp 4</option>
                  <option value="Lớp 5">Lớp 5</option>
                  <option value="Lớp 6">Lớp 6</option>
                  <option value="Lớp 7">Lớp 7</option>
                  <option value="Lớp 8">Lớp 8</option>
                  <option value="Lớp 9">Lớp 9</option>
                  <option value="Lớp 10">Lớp 10</option>
                  <option value="Lớp 11">Lớp 11</option>
                  <option value="Lớp 12">Lớp 12</option>
                </select>
              </div>

              {/* Môn học */}
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Môn Học:
                </label>
                {!isCustomSubject ? (
                  <div className="flex gap-1.5">
                    <select
                      value={subject}
                      onChange={(e) => {
                        if (e.target.value === '__custom__') {
                          setIsCustomSubject(true);
                        } else {
                          setSubject(e.target.value);
                        }
                      }}
                      className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                    >
                      <option value="Toán">Toán</option>
                      <option value="Ngữ văn">Ngữ văn</option>
                      <option value="Tiếng Anh">Tiếng Anh</option>
                      <option value="Vật lí">Vật lí</option>
                      <option value="Hóa học">Hóa học</option>
                      <option value="Sinh học">Sinh học</option>
                      <option value="Khoa học tự nhiên">Khoa học tự nhiên</option>
                      <option value="Lịch sử">Lịch sử</option>
                      <option value="Địa lí">Địa lí</option>
                      <option value="Lịch sử & Địa lí">Lịch sử & Địa lí</option>
                      <option value="Tin học">Tin học</option>
                      <option value="Giáo dục công dân">Giáo dục công dân</option>
                      <option value="Công nghệ">Công nghệ</option>
                      <option value="Tiếng Việt">Tiếng Việt</option>
                      <option value="__custom__">-- Nhập môn khác... --</option>
                    </select>
                  </div>
                ) : (
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      placeholder="Nhập tên môn học..."
                      value={customSubjectText}
                      onChange={(e) => setCustomSubjectText(e.target.value)}
                      className="w-full rounded-xl border border-blue-300 px-3 py-2 text-xs font-semibold focus:border-blue-500 focus:ring-1 focus:ring-blue-500 bg-white"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setIsCustomSubject(false);
                        setCustomSubjectText('');
                      }}
                      className="px-2.5 py-1 text-xs text-slate-500 hover:text-slate-700 border border-slate-300 rounded-xl bg-white"
                    >
                      Quay lại
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* DẠNG 1: ẢNH (HỖ TRỢ DÁN ẢNH CTRL+V TRỰC TIẾP) */}
          {uploadMode === 'image' && (
            <div className="space-y-4">
              <div className="rounded-2xl border-2 border-dashed border-blue-300 bg-blue-50/30 p-6 text-center hover:bg-blue-50/50 transition-colors">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100 text-blue-600 mx-auto mb-3">
                  <ImageIcon className="h-6 w-6" />
                </div>
                <div className="text-sm font-bold text-slate-900">
                  Dán ảnh chụp màn hình hoặc Tải ảnh từ máy
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Nhấn <kbd className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[11px] font-bold text-slate-800">Ctrl + V</kbd> để dán ảnh chụp trực tiếp
                </p>

                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-blue-700"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    <span>Chọn Ảnh Từ Máy</span>
                  </button>

                  <button
                    type="button"
                    onClick={handlePasteFromClipboardBtn}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-blue-300 bg-white px-4 py-2 text-xs font-bold text-blue-700 shadow-2xs hover:bg-blue-50"
                  >
                    <ClipboardPaste className="h-3.5 w-3.5 text-blue-600" />
                    <span>Dán Ảnh (Clipboard)</span>
                  </button>
                </div>

                <input
                  ref={imageInputRef}
                  type="file"
                  multiple
                  accept="image/*"
                  onChange={handleImageUpload}
                  className="hidden"
                />
              </div>

              {/* Danh sách ảnh đã đưa lên */}
              {uploadedImages.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-bold text-slate-700 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-blue-700">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      <span>Đã tải {uploadedImages.length} trang ảnh (Quét 100% tất cả các trang)</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setUploadedImages([])}
                      className="text-red-500 hover:text-red-700 font-semibold"
                    >
                      Xóa tất cả
                    </button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                    {uploadedImages.map((img, idx) => (
                      <div
                        key={`uploaded_img_${idx}_${img.name}`}
                        className="group relative rounded-xl border border-slate-200 bg-white p-2 shadow-2xs overflow-hidden"
                      >
                        <img
                          src={`data:${img.mimeType};base64,${img.data}`}
                          alt={img.name}
                          className="h-24 w-full object-cover rounded-lg"
                        />
                        <div className="mt-1 flex items-center justify-between text-[11px] text-slate-700">
                          <span className="truncate max-w-[100px] font-medium">{img.name}</span>
                          <button
                            type="button"
                            onClick={() => setUploadedImages((prev) => prev.filter((_, i) => i !== idx))}
                            className="text-red-500 hover:text-red-700 p-1 rounded hover:bg-red-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* DẠNG 2: FILE PDF HOẶC FILE WORD */}
          {uploadMode === 'document' && (
            <div className="space-y-4">
              {!documentFile ? (
                <div
                  onClick={() => docInputRef.current?.click()}
                  className="rounded-2xl border-2 border-dashed border-blue-300 bg-blue-50/30 p-8 text-center hover:bg-blue-50/50 transition-colors cursor-pointer group"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-100 text-blue-600 mx-auto mb-3 group-hover:scale-105 transition-transform">
                    <FileType className="h-6 w-6" />
                  </div>
                  <div className="text-sm font-bold text-slate-900">
                    Bấm để chọn File PDF hoặc File Word (.docx)
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Hỗ trợ tệp <strong>.pdf</strong>, <strong>.docx</strong>, <strong>.doc</strong>
                  </p>
                  <button
                    type="button"
                    className="mt-4 rounded-xl bg-blue-600 px-4 py-2 text-xs font-bold text-white shadow-xs"
                  >
                    Chọn Tệp Tin
                  </button>
                  <input
                    ref={docInputRef}
                    type="file"
                    accept=".pdf,.docx,.doc,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
                    onChange={handleDocumentUpload}
                    className="hidden"
                  />
                </div>
              ) : (
                <div className="rounded-2xl border-2 border-blue-200 bg-blue-50/40 p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white font-black text-xs uppercase">
                      {documentFile.type}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-slate-900 truncate max-w-xs">{documentFile.name}</div>
                      <div className="text-[11px] text-slate-500">Kích thước: {documentFile.size}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDocumentFile(null)}
                    className="p-1.5 text-red-500 hover:text-red-700"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* THÊM PHẦN: SỐ LƯỢNG ĐỀ CẦN TẠO */}
          <div className="rounded-2xl border border-blue-200 bg-blue-50/40 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-blue-600" />
                <span>Số lượng đề phát triển cần tạo:</span>
              </label>
              <span className="text-xs font-black text-blue-700 bg-white border border-blue-200 px-2 py-0.5 rounded-md">
                {variantCount} đề tương đương
              </span>
            </div>

            {/* Nút chọn nhanh số lượng */}
            <div className="flex items-center gap-2 pt-1">
              {[1, 2, 3, 4, 5].map((cnt) => (
                <button
                  key={cnt}
                  type="button"
                  onClick={() => setVariantCount(cnt)}
                  className={`flex-1 rounded-xl py-2 text-xs font-bold transition-all ${
                    variantCount === cnt
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {cnt} Đề
                </button>
              ))}
            </div>

            <p className="text-[11px] text-slate-500 italic mt-1">
              Hệ thống sẽ giữ vững 100% cấu trúc, mức độ nhận thức của đề mẫu, sinh bối cảnh thực tế sống động và cung cấp đáp án chi tiết.
            </p>
          </div>

          {/* Lỗi hiển thị nếu có */}
          {error && (
            <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 font-medium">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Loading Indicator */}
          {loading && (
            <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-5 text-center space-y-2">
              <Loader2 className="h-7 w-7 animate-spin text-blue-600 mx-auto" />
              <div className="text-xs font-bold text-blue-900">{loadingStep}</div>
              <p className="text-[11px] text-blue-700/80">
                Đang bảo toàn mục I, II, III, IV & Câu 1, Câu 2... in đậm màu xanh dương
              </p>
            </div>
          )}
        </div>

        {/* Footer Hành Động */}
        <div className="border-t border-slate-100 bg-slate-50 px-6 py-3.5 flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-100 transition-colors"
          >
            Đóng
          </button>

          <button
            type="button"
            onClick={handleProcessExam}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-2.5 text-xs font-bold text-white hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 transition-all shadow-md shadow-blue-200"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Đang Xử Lý...</span>
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                <span>Bắt Đầu Xử Lý & Tạo {variantCount} Đề</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
