"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Какие слои карты включены — и память об этом между заходами.
 *
 * Клик по узлу уводит на заметку, возврат назад монтирует страницу заново,
 * и без памяти карта каждый раз открывалась бы со слоями по умолчанию.
 * Тумблеры переключают один раз, а уходят с карты и возвращаются десятки —
 * так что сбрасывать выбор значит требовать ту же работу заново на каждый
 * круг.
 *
 * localStorage, а не таблица настроек: это вид, а не данные. Между
 * устройствами ему синхронизироваться незачем, а колонка в базе и запрос
 * на каждое нажатие — цена не по товару.
 */

const STORAGE_KEY = "md-note:graph-layers";

export interface GraphLayers {
  folders: boolean;
  similar: boolean;
  isolated: boolean;
}

/**
 * Слои при первом заходе. Ссылок здесь нет намеренно: они не слой,
 * а сама карта, и выключить их нечем.
 *
 * Папки включены, похожие — нет: смысловой слой считается полным перебором
 * векторов, и включать его за человека, который зашёл посмотреть, значит
 * платить за него при каждом первом открытии.
 */
export const DEFAULT_LAYERS: GraphLayers = {
  folders: true,
  similar: false,
  isolated: false,
};

/**
 * Разбор сохранённого значения.
 *
 * Отдельно от хука и без обращения к браузеру: в хранилище лежит строка,
 * которую мог записать прошлый выпуск приложения или рука из консоли.
 * Любое поле может оказаться чем угодно, и каждое проверяется поодиночке —
 * испорченный `similar` не должен уносить с собой настоящий `folders`.
 */
export function parseLayers(raw: string | null): GraphLayers {
  if (!raw) return DEFAULT_LAYERS;

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYERS;
  }

  if (typeof parsed !== "object" || parsed === null) return DEFAULT_LAYERS;

  const stored = parsed as Record<string, unknown>;

  const pick = (key: keyof GraphLayers): boolean =>
    typeof stored[key] === "boolean" ? stored[key] : DEFAULT_LAYERS[key];

  return {
    folders: pick("folders"),
    similar: pick("similar"),
    isolated: pick("isolated"),
  };
}

/**
 * Разобранное значение и строка, из которой оно получено.
 *
 * Кэш обязателен: useSyncExternalStore сравнивает снимки по ссылке и зациклит
 * рендер, если каждый вызов будет разбирать JSON заново. Сравниваем сырые
 * строки — они меняются ровно тогда, когда меняется хранилище.
 *
 * Состояние модульное, а не в хуке, потому что хранилище одно на вкладку:
 * это и есть тот «внешний источник», ради которого хук так называется.
 */
let cachedRaw: string | null | undefined;
let cachedLayers: GraphLayers = DEFAULT_LAYERS;

/**
 * Работает ли хранилище вообще. Обращение к localStorage бросает, когда его
 * запретили настройками браузера, — и тогда слои живут в памяти до ухода
 * со страницы. Забыть выбор не страшно; страшно, если тумблер после этого
 * перестанет переключаться, а именно так и вышло бы, продолжай мы читать
 * снимок из недоступного хранилища.
 */
let storageWorks = true;

function getSnapshot(): GraphLayers {
  if (!storageWorks) return cachedLayers;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (raw !== cachedRaw) {
      cachedRaw = raw;
      cachedLayers = parseLayers(raw);
    }
  } catch {
    storageWorks = false;
  }

  return cachedLayers;
}

/** На сервере хранилища нет — там слои всегда по умолчанию. */
function getServerSnapshot(): GraphLayers {
  return DEFAULT_LAYERS;
}

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);

  // storage приходит только из других вкладок — своя правка до себя же
  // не доходит, для неё и нужен список слушателей. Зато две открытые
  // карты не разъедутся.
  window.addEventListener("storage", onChange);

  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function write(layers: GraphLayers): void {
  const raw = JSON.stringify(layers);

  // Кэш обновляем до записи, а не после: снимок должен показать новое
  // значение даже там, где записать его некуда.
  cachedRaw = raw;
  cachedLayers = layers;

  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    storageWorks = false;
  }

  for (const listener of listeners) listener();
}

/**
 * useSyncExternalStore, а не useState с чтением в эффекте.
 *
 * Хранилище — внешний источник, и React умеет с ним работать сам: на сервере
 * он берёт снимок по умолчанию, при гидрации переключается на настоящий,
 * и разметка с состоянием тумблеров не расходится. Тот же приём, что
 * в usePrefersDark (src/components/note).
 */
export function useGraphLayers(): [
  GraphLayers,
  (patch: Partial<GraphLayers>) => void,
] {
  const layers = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  // Патчем, а не целым объектом: тумблеров три, и каждый знает только
  // про свой флаг. Текущее значение берётся из снимка, а не из замыкания,
  // поэтому у update нет зависимостей и он не меняется между рендерами.
  const update = useCallback(
    (patch: Partial<GraphLayers>) => write({ ...getSnapshot(), ...patch }),
    [],
  );

  return [layers, update];
}
