import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// "/dashboard" already covers every sub-route; /dashboard/billing is listed so the billing page is protected on purpose.
const PROTECTED = ["/dashboard", "/dashboard/billing", "/reset-password"];
const AUTH_PAGES = ["/login", "/register", "/forgot-password"];

function matches(path: string, bases: string[]): boolean {
  return bases.some((p) => path === p || path.startsWith(`${p}/`));
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const path = request.nextUrl.pathname;
  const isProtected = matches(path, PROTECTED);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Fail closed: without configuration, protected pages are never served.
  if (!url || !anonKey) {
    if (isProtected) return NextResponse.redirect(new URL("/login", request.url));
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // getUser() verifies the token with Supabase; getSession() alone would trust the cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && isProtected) {
    const target = request.nextUrl.clone();
    target.pathname = path === "/reset-password" ? "/forgot-password" : "/login";
    target.search = "";
    if (path.startsWith("/dashboard")) target.searchParams.set("next", path);
    const redirect = NextResponse.redirect(target);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }

  if (user && matches(path, AUTH_PAGES)) {
    const target = request.nextUrl.clone();
    target.pathname = "/dashboard";
    target.search = "";
    const redirect = NextResponse.redirect(target);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  }

  return response;
}
