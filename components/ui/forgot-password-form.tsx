"use client";
import { useState } from "react";
import { User, ArrowRight } from "lucide-react";
import { useAuth } from "@/context/AuthContext";

export function ForgotPasswordForm() {
  const { sendPasswordResetEmail } = useAuth();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const err = await sendPasswordResetEmail(email);
    if (err) {
      setError(err);
      setLoading(false);
    } else {
      setSuccess(true);
    }
  };

  if (success) {
    return (
      <div className="w-full max-w-sm p-8 space-y-6 bg-white/10 backdrop-blur-lg rounded-2xl border border-white/20 shadow-2xl text-center">
        <div className="w-16 h-16 bg-blue-500/20 rounded-full flex items-center justify-center mx-auto">
          <svg className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-white">이메일을 확인하세요</h2>
        <p className="text-sm text-gray-300">
          <span className="text-blue-400 font-semibold">{email}</span>으로<br />
          비밀번호 재설정 링크를 보냈습니다.
        </p>
        <a href="/" className="inline-block text-xs text-gray-400 hover:text-white transition">
          로그인 페이지로 돌아가기
        </a>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm p-8 space-y-6 bg-white/10 backdrop-blur-lg rounded-2xl border border-white/20 shadow-2xl">
      <div className="text-center">
        <h2 className="text-3xl font-bold text-white">비밀번호 찾기</h2>
        <p className="mt-2 text-sm text-gray-300">가입한 이메일로 재설정 링크를 보내드립니다</p>
      </div>
      <form className="space-y-8" onSubmit={handleSubmit}>
        <div className="relative z-0">
          <input
            type="email"
            id="forgot_email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="block py-2.5 px-0 w-full text-sm text-white bg-transparent border-0 border-b-2 border-gray-300 appearance-none focus:outline-none focus:ring-0 focus:border-blue-500 peer"
            placeholder=" "
            required
          />
          <label
            htmlFor="forgot_email"
            className="absolute text-sm text-gray-300 duration-300 transform -translate-y-6 scale-75 top-3 -z-10 origin-[0] peer-focus:left-0 peer-focus:text-blue-400 peer-placeholder-shown:scale-100 peer-placeholder-shown:translate-y-0 peer-focus:scale-75 peer-focus:-translate-y-6"
          >
            <User className="inline-block mr-2 -mt-1" size={16} />
            이메일 주소
          </label>
        </div>

        {error && <p className="text-red-400 text-xs text-center">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="group w-full flex items-center justify-center py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed rounded-lg text-white font-semibold focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 focus:ring-blue-500 transition-all duration-300"
        >
          {loading ? "전송 중..." : (
            <>
              재설정 링크 보내기
              <ArrowRight className="ml-2 h-5 w-5 transform group-hover:translate-x-1 transition-transform" />
            </>
          )}
        </button>
      </form>
      <p className="text-center text-xs text-gray-400">
        <a href="/" className="font-semibold text-blue-400 hover:text-blue-300 transition">
          로그인으로 돌아가기
        </a>
      </p>
    </div>
  );
}
