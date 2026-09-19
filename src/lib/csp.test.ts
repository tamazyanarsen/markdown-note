import { describe, expect, it } from "vitest";

import { buildCsp, generateNonce } from "./csp";

/**
 * Политика — это строка, и в этом вся беда: потерянная директива не падает
 * и не ломает страницу, она просто перестаёт защищать. Поэтому проверяется
 * не «собралось без ошибок», а наличие каждого куска по отдельности.
 */

const NONCE = "test-nonce-value";

/** Значение одной директивы из собранного заголовка. */
function directive(csp: string, name: string): string | null {
  const found = csp
    .split("; ")
    .find((part) => part === name || part.startsWith(`${name} `));

  return found ?? null;
}

describe("nonce", () => {
  it("каждый раз новый", () => {
    const values = new Set(Array.from({ length: 100 }, generateNonce));
    expect(values.size).toBe(100);
  });

  it("16 байт в base64 — это 24 символа", () => {
    expect(generateNonce()).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

describe("политика", () => {
  const prod = buildCsp(NONCE, false);
  const dev = buildCsp(NONCE, true);

  it("пускает скрипты только по nonce", () => {
    expect(directive(prod, "script-src")).toBe(
      `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`,
    );
  });

  it("никогда не разрешает инлайн скриптов", () => {
    // Главная проверка файла: 'unsafe-inline' в script-src сводит на нет
    // весь смысл затеи, а добавить его случайно очень легко.
    expect(prod).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(directive(prod, "script-src")).not.toContain("'unsafe-inline'");
    expect(directive(dev, "script-src")).not.toContain("'unsafe-inline'");
  });

  it("eval разрешён только в dev", () => {
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(prod, "script-src")).not.toContain("'unsafe-eval'");
  });

  it("websocket горячей перезагрузки — только в dev", () => {
    expect(directive(dev, "connect-src")).toBe("connect-src 'self' ws:");
    expect(directive(prod, "connect-src")).toBe("connect-src 'self'");
  });

  it("апгрейд на https — только в проде", () => {
    expect(directive(prod, "upgrade-insecure-requests")).not.toBeNull();
    expect(directive(dev, "upgrade-insecure-requests")).toBeNull();
  });

  it("закрывает всё, для чего нет отдельного разрешения", () => {
    expect(directive(prod, "default-src")).toBe("default-src 'self'");
    expect(directive(prod, "object-src")).toBe("object-src 'none'");
    expect(directive(prod, "base-uri")).toBe("base-uri 'self'");
    expect(directive(prod, "form-action")).toBe("form-action 'self'");
    expect(directive(prod, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("картинки из markdown грузятся по https", () => {
    // В заметку можно вставить ссылку на чужую картинку — это законно,
    // и политика не должна её резать.
    expect(directive(prod, "img-src")).toBe("img-src 'self' https:");
  });

  it("стили разрешены инлайном осознанно", () => {
    // Radix, sonner и cmdk вставляют <style> уже на клиенте, nonce им
    // взять неоткуда. Разбор — в комментарии к директиве в csp.ts.
    expect(directive(prod, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
  });
});
