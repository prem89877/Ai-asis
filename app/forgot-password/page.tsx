import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/PasswordForms";

export const metadata: Metadata = { title: "Reset password | AI Asis" };

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
