import type { Permissions } from '#shared/utils/permissions';

/**
 * Permission check of the logged in user (reactive)
 */
export function usePermission<Resource extends keyof Permissions>(
  resource: Resource,
  action: Permissions[Resource]['action']
) {
  const authStore = useAuthStore();
  return computed(() => {
    const user = authStore.userData;
    if (!user) return false;
    return hasPermissions(user, resource, action);
  });
}
