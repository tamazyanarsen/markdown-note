import { cache } from "react";

import { auth } from "./auth";
import { unauthorized, forbidden } from "./errors";

export interface CurrentUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  isApproved: boolean;
}

/**
 * Текущий пользователь или null. cache() схлопывает повторные вызовы
 * внутри одного рендера в один запрос к БД.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  if (!session?.user?.id) return null;

  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    image: session.user.image,
    isApproved: session.user.isApproved,
  };
});

/**
 * Пользователь, который имеет право работать со своим деревом.
 * Бросает AppError — route handler превращает её в 401/403 через toErrorResponse.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw unauthorized();
  if (!user.isApproved) throw forbidden();
  return user;
}
