import { SmokeyBackground } from "@/components/ui/login-form";
import { ResetPasswordForm } from "@/components/ui/reset-password-form";

export default function ResetPasswordPage() {
  return (
    <main className="relative w-screen h-screen bg-gray-900">
      <SmokeyBackground className="absolute inset-0" />
      <div className="relative z-10 flex items-center justify-center w-full h-full p-4">
        <ResetPasswordForm />
      </div>
    </main>
  );
}
