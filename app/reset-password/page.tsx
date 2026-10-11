import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ResetPasswordForm } from "@/components/auth/PasswordForms";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "New password | AI Asis" };

export default async function ResetPasswordPage() {
  const {
    data: { user },
  } = await createClient().auth.getUser();
  if (!user) redirect("/forgot-password");
  return <ResetPasswordForm />;
}
