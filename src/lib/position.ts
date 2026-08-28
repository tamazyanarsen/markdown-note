/**
 * Дробная сортировка (fractional indexing).
 *
 * Вставка между соседями — среднее их позиций, поэтому перетаскивание
 * трогает одну строку, а не перенумеровывает весь список.
 *
 * Колонка — numeric(20, 10), то есть ровно 10 знаков после запятой.
 * Считаем в BigInt, масштабируя на 10^10: обычный JS-float на десятом
 * делении пополам уже врал бы.
 *
 * Зазор конечен: примерно после 33 вставок между одной и той же парой
 * соседей делить становится нечего. Тогда positionBetween сообщает
 * needsRebalance, а вызывающий код перенумеровывает ветку через
 * rebalancedPositions.
 */

const DECIMALS = 10n;
const SCALE = 10n ** DECIMALS;

/** Шаг между соседями при добавлении в конец и при ребалансировке. */
export const POSITION_STEP = 1000n * SCALE;

export const DEFAULT_POSITION = "1000";

function parse(value: string): bigint {
  const [whole, fraction = ""] = value.trim().split(".");
  const paddedFraction = fraction.padEnd(Number(DECIMALS), "0").slice(0, Number(DECIMALS));
  const sign = whole.startsWith("-") ? -1n : 1n;
  const absWhole = whole.replace("-", "") || "0";
  return sign * (BigInt(absWhole) * SCALE + BigInt(paddedFraction || "0"));
}

function format(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(Number(DECIMALS), "0").replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${text}` : text;
}

export interface PositionResult {
  position: string;
  /** true — зазор исчерпан, ветку надо перенумеровать. */
  needsRebalance: boolean;
}

/**
 * Позиция строго между prev и next.
 * null означает край списка: prev = null — вставка в начало, next = null — в конец.
 */
export function positionBetween(
  prev: string | null,
  next: string | null,
): PositionResult {
  if (prev === null && next === null) {
    return { position: DEFAULT_POSITION, needsRebalance: false };
  }

  if (prev === null) {
    const after = parse(next!);
    // Место перед первым элементом: делим пополам расстояние до нуля.
    if (after <= 1n) return { position: format(after), needsRebalance: true };
    return { position: format(after / 2n), needsRebalance: false };
  }

  if (next === null) {
    return { position: format(parse(prev) + POSITION_STEP), needsRebalance: false };
  }

  const before = parse(prev);
  const after = parse(next);

  // Соседи переданы в неверном порядке — считаем это ошибкой вызывающего кода.
  if (before >= after) {
    return { position: format(before + POSITION_STEP), needsRebalance: true };
  }

  const middle = (before + after) / 2n;

  // Делить больше нечего: середина совпала с одним из краёв.
  if (middle <= before || middle >= after) {
    return { position: format(before), needsRebalance: true };
  }

  return { position: format(middle), needsRebalance: false };
}

/** Ровные позиции 1000, 2000, 3000… для перенумерации ветки. */
export function rebalancedPositions(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    format(POSITION_STEP * BigInt(index + 1)),
  );
}
