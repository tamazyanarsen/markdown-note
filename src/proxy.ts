import { NextResponse, type NextRequest } from "next/server";

/**
 * Next 16 называет этот слой proxy (бывший middleware).
 *
 * Он работает на edge-рантайме, поэтому здесь НЕТ обращений к базе:
 * сессии у нас хранятся в Postgres, а auth() туда ходит.
 *
 * Проверка cookie ниже — только оптимизация: она разворачивает гостя
 * на /signin, не поднимая рендер страницы. Настоящая проверка прав живёт
 * в requireUser() (src/lib/session.ts) и в доменном слое.
 */

const SESSION_COOKIES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
];

/**
 * Пути, которые редиректить нельзя.
 *
 * /signin, /f/ и /n/ публичны по замыслу. /api/ — потому что клиенту API
 * нужен JSON с кодом ошибки, а не 307 на HTML-страницу входа: fetch пошёл бы
 * по редиректу и получил бы 200 со страницей логина вместо честного 401.
 */
const UNGUARDED_PREFIXES = ["/signin", "/f/", "/n/", "/api/"];

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isUnguarded = UNGUARDED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );

  if (isUnguarded) {
    return NextResponse.next();
  }

  const hasSessionCookie = SESSION_COOKIES.some(
    (name) => request.cookies.get(name)?.value,
  );

  if (!hasSessionCookie) {
    return NextResponse.redirect(new URL("/signin", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Статику, favicon и служебные пути Next не трогаем.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)",
  ],
};
