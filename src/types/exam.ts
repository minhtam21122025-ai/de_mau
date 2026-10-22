export type CognitiveLevel = 'Nhận biết' | 'Thông hiểu' | 'Vận dụng' | 'Vận dụng cao';

export interface QuestionOption {
  key: string; // 'A' | 'B' | 'C' | 'D'
  content: string;
}

export interface TrueFalseSubQuestion {
  key: 'a' | 'b' | 'c' | 'd';
  content: string;
  isCorrect: boolean;
  explanation?: string;
}

export interface ExamQuestion {
  questionNumber: number;
  content: string;
  cognitiveLevel: CognitiveLevel;
  topic?: string;
  hasVisual?: boolean;
  visualDescription?: string;
  svgCode?: string;
  imageUrl?: string;
  realWorldContext?: string;
  options?: QuestionOption[];
  subQuestions?: TrueFalseSubQuestion[];
  shortAnswer?: string;
  correctAnswer?: string;
  explanation?: string;
  deepExplanation?: string;
}

export interface ExamPart {
  partId: string;
  partTitle: string;
  instruction?: string;
  questions: ExamQuestion[];
}

export interface ExamMatrixSummary {
  topics: string[];
  cognitiveLevels?: {
    nhanBiet: number;
    thongHieu: number;
    vanDung: number;
    vanDungCao: number;
  };
  formats?: string[];
}

export interface ExamData {
  id?: string;
  title: string;
  examCode?: string;
  subject: string;
  grade: string;
  examType?: string; // 'Giữa kì' | 'Cuối kì' | 'Giữa học kì I' | 'Cuối học kì I' | 'Giữa học kì II' | 'Cuối học kì II' | string
  timeAllowed?: string;
  totalScore?: number;
  matrixSummary?: ExamMatrixSummary;
  parts: ExamPart[];
  quickAnswerKey?: Array<{ question: number; answer: string }>;
  rawOcrNotes?: string;
  pedagogicalNotes?: string;
  createdAt?: string;
}

export interface ExamVariantConfig {
  variantIndex: number;
  difficulty: 'Chuẩn 100% tương đương' | 'Nâng cao nhẹ (+10% Vận dụng)' | 'Củng cố cơ bản (-10%)';
  contextStyle: 'Đời sống thực tế Việt Nam' | 'Khoa học công nghệ hiện đại' | 'Kinh tế & tài chính' | 'Ngữ cảnh chuẩn Bộ GD&ĐT';
  note?: string;
}
