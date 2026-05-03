import { createContext, useContext, useState, ReactNode } from "react";

type AccessType = "admin" | "viewer" | null;

interface PermissionContextValue {
  type: AccessType;
  setType: (t: AccessType) => void;
}

const PermissionContext = createContext<PermissionContextValue>({
  type: null,
  setType: () => {},
});

export function PermissionProvider({ children }: { children: ReactNode }) {
  const [type, setType] = useState<AccessType>(null);
  return (
    <PermissionContext.Provider value={{ type, setType }}>
      {children}
    </PermissionContext.Provider>
  );
}

/** Hook to read the current access permission type */
export function usePermission(): AccessType {
  return useContext(PermissionContext).type;
}

/** Hook to update the permission type (used in AuthGate after /api/me) */
export function useSetPermission(): (t: AccessType) => void {
  return useContext(PermissionContext).setType;
}
