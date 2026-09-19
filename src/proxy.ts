import { NextResponse, type NextRequest } from "next/server";

import { buildCsp, generateNonce } from "@/lib/csp";

/**
 * Next 16 называет этот слой proxy (бывший middleware).
 *
 * Он работает на edge-рантайме, поэтому здесь НЕТ обращений к базе:
 * сессии у нас хранятся в Postgres, а auth() туда ходит.
 *
 * Две обязанности, и вторая важнее первой:
 *
 *  1. Развернуть гостя на /signin, не поднимая рендер страницы. Это только
 *     оптимизация — настоящая проверка прав живёт в requireUser()
 *     (src/lib/session.ts) и в доменном слое.
 *  2. Поставить CSP с одноразовым nonce. Здесь, а не в next.config.ts,
 *     потому что nonce обязан быть своим на каждый ответ.
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

const isDev = process.env.NODE_ENV === "development";

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // API отдаёт JSON и файлы вложений, скриптов там нет — ни политики,
  // ни nonce эти ответы не требуют. Заодно не тратим случайные байты
  // на каждое автосохранение редактора.
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const nonce = generateNonce();
  const csp = buildCsp(nonce, isDev);

  const isUnguarded = UNGUARDED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );

  const hasSessionCookie = SESSION_COOKIES.some(
    (name) => request.cookies.get(name)?.value,
  );

  if (!isUnguarded && !hasSessionCookie) {
    // У редиректа нет тела, но заголовок ставим и здесь: политика должна
    // быть на каждом ответе, а не на тех, про которые мы вспомнили.
    const redirect = NextResponse.redirect(new URL("/signin", request.url));
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }

  // Заголовки запроса, а не только ответа: Next достаёт nonce из политики
  // на входе и сам проставляет его своим скриптам — рамочным, чанкам
  // страницы и инлайну, который он генерирует. Руками расставлять nonce
  // по тегам не нужно, но без этих двух строк ему его взять неоткуда.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  // Статику, favicon и служебные пути Next не трогаем.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp)$).*)",
  ],
};
