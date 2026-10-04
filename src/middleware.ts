import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  // /debug/* are component playgrounds with mock data. They are built into the bundle
  // (static pages), so gate them at the edge: 404 in production, open in dev.
  if (req.nextUrl.pathname.startsWith("/debug") && process.env.NODE_ENV === "production") {
    return new NextResponse(null, { status: 404 });
  }
  // Protect /host routes — must be signed in
  if (req.nextUrl.pathname.startsWith("/host") && !req.auth) {
    const signInUrl = new URL("/auth/signin", req.url);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }
});

export const config = {
  matcher: ["/host", "/host/:path*", "/debug", "/debug/:path*"],
};
