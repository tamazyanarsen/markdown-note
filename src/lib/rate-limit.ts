import { rateLimited } from "./errors";

/**
 * Token bucket в памяти процесса.
 *
 * Инстанс один (docker-compose с единственным контейнером app), поэтому
 * общего хранилища не нужно. Если инстансов станет больше, здесь меняется
 * только backend — на Redis; сигнатура consume остаётся прежней.
 *
 * Это защита от перебора и случайного цикла в клиенте, а не от DDoS:
 * настоящий флуд отсекается на уровне реверс-прокси.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/** Раз в 5 минут выкидываем полные корзины, чтобы Map не рос бесконечно. */
const SWEEP_INTERVAL_MS = 5 * 60_000;
let lastSweepAt = 0;

function sweep(now: number, capacity: number) {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;

  for (const [key, bucket] of buckets) {
    if (bucket.tokens >= capacity && now - bucket.updatedAt > SWEEP_INTERVAL_MS) {
      buckets.delete(key);
    }
  }
}

export interface RateLimitOptions {
  /** Сколько запросов подряд разрешено. */
  capacity: number;
  /** За какое окно корзина полностью восстанавливается, мс. */
  refillMs: number;
}

/** Профили под разные типы эндпоинтов. */
export const RATE_LIMITS = {
  /** Изменение данных: создание, правка, перемещение, удаление. */
  mutation: { capacity: 60, refillMs: 60_000 },
  /** Автосохранение редактора — заметно чаще обычных мутаций. */
  autosave: { capacity: 240, refillMs: 60_000 },
  /** Чтение публичных страниц гостями. */
  publicRead: { capacity: 120, refillMs: 60_000 },
  /** Полнотекстовый поиск: летит на каждое нажатие клавиши, но локальный. */
  search: { capacity: 120, refillMs: 60_000 },
  /**
   * Смысловой поиск. Строже остальных: каждый запрос — это вызов внешнего
   * API за деньги. Клиент шлёт его только после паузы в наборе, так что
   * тридцати в минуту хватает с запасом, а зациклившийся клиент
   * не потратит бюджет.
   */
  semanticSearch: { capacity: 30, refillMs: 60_000 },
  /**
   * Вопрос к заметкам. Строже смыслового поиска: каждый запрос — это и
   * векторизация, и генерация, а генерация на порядок дороже. Вопрос задаёт
   * человек руками, по одному, так что пятнадцати в минуту хватает,
   * а зациклившийся клиент не разорит.
   */
  ask: { capacity: 15, refillMs: 60_000 },
} as const satisfies Record<string, RateLimitOptions>;

/**
 * Списывает один токен. Бросает AppError(RATE_LIMITED) → 429, если корзина пуста.
 * key должен различать субъектов: user:<id> для авторизованных, ip:<addr> для гостей.
 */
export function consume(key: string, options: RateLimitOptions): void {
  const now = Date.now();
  sweep(now, options.capacity);

  const bucket = buckets.get(key);

  if (!bucket) {
    buckets.set(key, { tokens: options.capacity - 1, updatedAt: now });
    return;
  }

  const refilled =
    bucket.tokens +
    ((now - bucket.updatedAt) / options.refillMs) * options.capacity;

  const tokens = Math.min(options.capacity, refilled);

  if (tokens < 1) {
    // updatedAt не двигаем: иначе накопленное время сгорало бы
    // на каждой отклонённой попытке и корзина не восстанавливалась.
    throw rateLimited();
  }

  buckets.set(key, { tokens: tokens - 1, updatedAt: now });
}

/** IP клиента за реверс-прокси. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
