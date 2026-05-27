import { Suspense } from "react";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-[#060810] text-[#e6edf3] font-sans antialiased">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
