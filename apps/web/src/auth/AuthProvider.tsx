import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  hasRole,
  type Edition,
  type LoginInput,
  type MeResponse,
  type Role,
  type SetupInput,
  type SetupStatus,
  type User,
} from "@bullpane/shared";
import { api, isApiError, setApiHandlers } from "@/api/client";
import { openUpsell } from "@/edition/upsellStore";
import { toast } from "@/components/Toast";

export interface AuthContextValue {
  user: User | null;
  edition: Edition | null;
  /** initial /auth/me + /setup/status round-trip still in flight */
  loading: boolean;
  needsSetup: boolean;
  refresh: () => Promise<void>;
  login: (input: LoginInput) => Promise<MeResponse>;
  setup: (input: SetupInput) => Promise<MeResponse>;
  logout: () => Promise<void>;
  /** replace the edition (after license changes) */
  setEdition: (edition: Edition) => void;
  can: (required: Role) => boolean;
  isAdmin: boolean;
  isOperator: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [edition, setEditionState] = useState<Edition | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const locationRef = useRef(location);
  locationRef.current = location;

  const loadAnonymous = useCallback(async () => {
    const [status, pubEdition] = await Promise.allSettled([
      api.get<SetupStatus>("/setup/status", { silent: true }),
      api.get<Edition>("/edition", { silent: true }),
    ]);
    if (status.status === "fulfilled") setNeedsSetup(!!status.value.needsSetup);
    if (pubEdition.status === "fulfilled") setEditionState(pubEdition.value);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<MeResponse>("/auth/me", { silent: true });
      setUser(me.user);
      setEditionState(me.edition);
      setNeedsSetup(false);
    } catch (e) {
      setUser(null);
      if (isApiError(e) && e.status === 401) await loadAnonymous();
      else if (isApiError(e) && e.status === 0) toast.error("Could not reach the server");
    } finally {
      setLoading(false);
    }
  }, [loadAnonymous]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Central handlers for the API client.
  useEffect(() => {
    setApiHandlers({
      onUnauthenticated: () => {
        setUser(null);
        qc.clear();
        const path = locationRef.current.pathname;
        if (!path.startsWith("/login") && !path.startsWith("/setup")) {
          navigate("/login", { replace: true, state: { from: locationRef.current } });
        }
      },
      onProRequired: (feature) => openUpsell(feature),
      onDemoLocked: () => toast.warning("This action is locked in the demo"),
    });
  }, [navigate, qc]);

  const login = useCallback(
    async (input: LoginInput) => {
      const me = await api.post<MeResponse>("/auth/login", input, { silent: [401] });
      setUser(me.user);
      setEditionState(me.edition);
      setNeedsSetup(false);
      qc.clear();
      return me;
    },
    [qc],
  );

  const setup = useCallback(
    async (input: SetupInput) => {
      const me = await api.post<MeResponse>("/setup", input);
      setUser(me.user);
      setEditionState(me.edition);
      setNeedsSetup(false);
      return me;
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout", {}, { silent: true });
    } finally {
      setUser(null);
      qc.clear();
      navigate("/login", { replace: true });
    }
  }, [navigate, qc]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      edition,
      loading,
      needsSetup,
      refresh,
      login,
      setup,
      logout,
      setEdition: setEditionState,
      can: (required) => (user ? hasRole(user.role, required) : false),
      isAdmin: user?.role === "admin",
      isOperator: user ? hasRole(user.role, "operator") : false,
    }),
    [user, edition, loading, needsSetup, refresh, login, setup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
