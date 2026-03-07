import { SmokeyBackground } from "@/components/ui/login-form";
import { ForgotPasswordForm } from "@/components/ui/forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <main className="relative w-screen h-screen bg-gray-900">
      <SmokeyBackground className="absolute inset-0" />
      <div className="relative z-10 flex items-center justify-center w-full h-full p-4">
        <ForgotPasswordForm />
      </div>
    </main>
  );
}
