import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/AuthForm";

export const metadata: Metadata = { title: "Create account | AI Asis" };

export default function RegisterPage() {
  return <AuthForm mode="register" />;
}
