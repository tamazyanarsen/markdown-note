import { useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * Узкий ли экран — от этого зависит, покажет ли Sidebar колонку или Sheet.
 *
 * Отступление от шаблона shadcn: там useState + useEffect, а это setState
 * прямо в эффекте, на который ругается react-hooks. useSyncExternalStore
 * делает то же самое без лишнего рендера — так же, как usePrefersDark.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    // На сервере ширины нет — считаем экран широким, чтобы разметка совпала
    // при гидрации. На телефоне панель просто останется закрытой.
    () => false,
  );
}
