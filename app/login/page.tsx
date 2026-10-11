import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/AuthForm";
import { safeNextPath } from "@/lib/security/redirect";

export const metadata: Metadata = { title: "Log in | AI Asis" };

export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string };
}) {
  return (
    <AuthForm
      mode="login"
      next={safeNextPath(searchParams.next)}
      callbackError={searchParams.error === "auth_callback"}
    />
  );
}
