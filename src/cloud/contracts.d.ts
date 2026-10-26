/**
 * Type surface of the vendored lumina-contracts.cjs bundle.
 *
 * Hand-maintained on purpose: the client must not need zod's own typings, so
 * schemas are exposed through the minimal ZodLikeSchema interface instead of
 * zod generics. Runtime export parity with src/index.ts is enforced by
 * test/bundle.test.ts; keep this file in step when adding exports.
 */

/** Minimal validation surface of a zod schema (runtime validation is optional for the client). */
export interface ZodLikeSchema<T> {
  parse(data: unknown): T;
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown };
}

/** Enum schemas additionally expose the list of allowed values (for UI dictionaries). */
export interface ZodLikeEnum<T> extends ZodLikeSchema<T> {
  options: readonly T[];
}

export declare const API_VERSION: "v1";

export type ContentType = "image";
export declare const ContentType: ZodLikeEnum<ContentType>;

export type ContentRating = "general" | "suggestive" | "explicit";
export declare const ContentRating: ZodLikeEnum<ContentRating>;

export type ContentWarning = "violence" | "gore" | "flashing";
export declare const ContentWarning: ZodLikeEnum<ContentWarning>;

export type ContentStatus =
  | "draft"
  | "pending_review"
  | "published"
  | "rejected"
  | "hidden"
  | "removed";
export declare const ContentStatus: ZodLikeEnum<ContentStatus>;

export type UploadStatus =
  | "pending"
  | "uploaded"
  | "processing"
  | "processed"
  | "failed"
  | "expired";
export declare const UploadStatus: ZodLikeEnum<UploadStatus>;

export type EntitlementKey = "online_catalog" | "creator_uploads";
export declare const EntitlementKey: ZodLikeEnum<EntitlementKey>;

export type UserRole = "user" | "admin";
export declare const UserRole: ZodLikeEnum<UserRole>;

export type HealthResponse = { ok: true; service: "lumina-cloud-api"; version: string };
export declare const HealthResponse: ZodLikeSchema<HealthResponse>;

/** Every non-2xx /v1 response: stable machine-readable code + human message. */
export type ApiError = { error: { code: string; message: string } };
export declare const ApiError: ZodLikeSchema<ApiError>;

export type AuthExchangeRequest = {
  code: string;
  pkce_verifier: string;
  /** Optional device label shown in a future session list, e.g. "Lumina on WORK-PC". */
  client_label?: string;
};
export declare const AuthExchangeRequest: ZodLikeSchema<AuthExchangeRequest>;

export type PublicUser = {
  id: string;
  display_name: string;
  email: string | null;
  role: UserRole;
  explicit_opt_in: boolean;
  created_at: number;
};
export declare const PublicUser: ZodLikeSchema<PublicUser>;

export type AuthExchangeResponse = { session_token: string; user: PublicUser };
export declare const AuthExchangeResponse: ZodLikeSchema<AuthExchangeResponse>;

/** entitlements are plain strings on purpose: an older bundle must not choke on a new key. */
export type MeResponse = { user: PublicUser; entitlements: string[] };
export declare const MeResponse: ZodLikeSchema<MeResponse>;
/** PUT /v1/me/explicit: on needs the user's age confirmation; off is always allowed. */
export type ExplicitSettingRequest =
  | { explicit_opt_in: true; age_confirmed: true }
  | { explicit_opt_in: false };
export declare const ExplicitSettingRequest: ZodLikeSchema<ExplicitSettingRequest>;
/** Without a session: "1" when the person confirmed 18+ in the app. */
export declare const ADULT_CONFIRMED_HEADER: "X-Znada-Adult-Confirmed";

export type LogoutResponse = { ok: true };
export declare const LogoutResponse: ZodLikeSchema<LogoutResponse>;

export type UploadImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export declare const UploadImageMime: ZodLikeEnum<UploadImageMime>;

/** Hard intake caps; check on the client BEFORE uploading. */
export declare const UPLOAD_LIMITS: {
  readonly maxBytes: number;
  readonly maxPixels: number;
  readonly previewMaxBytes: number;
  readonly previewLongSide: number;
};

export type UploadCreateRequest = {
  mime: UploadImageMime;
  bytes: number;
  width: number;
  height: number;
  title: string;
  rating: ContentRating;
};
export declare const UploadCreateRequest: ZodLikeSchema<UploadCreateRequest>;

export type UploadCreateResponse = {
  upload_id: string;
  content_id: string;
  original_put_url: string;
  preview_put_url: string;
  urls_expire_at: number;
};
export declare const UploadCreateResponse: ZodLikeSchema<UploadCreateResponse>;

export type UploadStatusResponse = {
  upload_id: string;
  status: UploadStatus;
  content_id: string | null;
  last_error: string | null;
};
export declare const UploadStatusResponse: ZodLikeSchema<UploadStatusResponse>;

export type CatalogItem = {
  id: string;
  title: string;
  rating: ContentRating;
  published_at: number;
  width: number;
  height: number;
  bytes: number;
  format: string;
  thumb_url: string;
};
export declare const CatalogItem: ZodLikeSchema<CatalogItem>;

export type CatalogPage = { items: CatalogItem[]; next_cursor: string | null };
export declare const CatalogPage: ZodLikeSchema<CatalogPage>;

export type ContentCard = {
  id: string;
  title: string;
  rating: ContentRating;
  published_at: number;
  width: number;
  height: number;
  bytes: number;
  format: string;
  tags: string[];
  warnings: string[];
  preview_url: string;
};
export declare const ContentCard: ZodLikeSchema<ContentCard>;

export type DownloadResponse = { url: string; expires_at: number };
export declare const DownloadResponse: ZodLikeSchema<DownloadResponse>;

export type FavoritesResponse = { items: CatalogItem[] };
export declare const FavoritesResponse: ZodLikeSchema<FavoritesResponse>;

/** Stable /v1 endpoint paths. */
export declare const API_PATHS: {
  readonly bookmarkOperations: "/v1/bookmarks/operations";
  readonly bookmarkChanges: "/v1/bookmarks/changes";
  readonly bookmarkSnapshot: "/v1/bookmarks/snapshot";
  readonly bookmarkImport: "/v1/bookmarks/import";
  readonly health: "/v1/health";
  readonly authGoogleStart: "/v1/auth/google/start";
  readonly authExchange: "/v1/auth/exchange";
  readonly logout: "/v1/auth/logout";
  readonly me: "/v1/me";
  readonly meExplicit: "/v1/me/explicit";
  readonly uploads: "/v1/uploads";
  readonly catalog: "/v1/catalog";
  readonly content: "/v1/content";
  readonly favorites: "/v1/favorites";
  readonly contentPage: "/c";
};

/** CLOUD-019 metadata-only bookmarks; availability must be checked per environment. */
export declare const BOOKMARK_LIMITS: {
  readonly known_keys: 10000;
  readonly daily_events: 10000;
  readonly request_bytes: 16384;
  readonly default_page: 100;
  readonly max_page: 200;
  readonly history_ms: 2592000000;
  readonly snapshot_ms: 900000;
  /** No longer enforced; snapshots store nothing. */
  readonly active_snapshots: 2;
  readonly import_items: 100;
  readonly import_request_bytes: 262144;
  readonly import_idle_ms: 900000;
};
export type BookmarkSource = "gelbooru" | "danbooru" | "znada" | "wallhaven";
/** Id rule of each source; `znada` is a catalog wallpaper ULID, `wallhaven` a wallhaven.cc id. */
export declare const BOOKMARK_SOURCE_IDS: { readonly [S in BookmarkSource]: RegExp };
export declare const CATALOG_BOOKMARK_SOURCE: "znada";
export declare const BookmarkSource: ZodLikeEnum<BookmarkSource>;
export type BookmarkKey = { source: BookmarkSource; post_id: string };
export declare const BookmarkKey: ZodLikeSchema<BookmarkKey>;
export type BookmarkMetadata = {
  title?: string;
  author?: string;
  source_tags?: string[];
  user_tags?: string[];
  width?: number;
  height?: number;
  source_rating?: ContentRating;
  posted_at?: number;
};
export declare const BookmarkMetadata: ZodLikeSchema<BookmarkMetadata>;
export type BookmarkOperation = BookmarkKey & {
  operation_id: string;
  expected_revision: number;
} & ({ type: "add" | "update"; metadata: BookmarkMetadata } | { type: "remove" });
export declare const BookmarkOperation: ZodLikeSchema<BookmarkOperation>;
export type BookmarkImportRequest = {
  items: (BookmarkKey & { metadata: BookmarkMetadata; favorited_at?: number })[];
  final: boolean;
};
export declare const BookmarkImportRequest: ZodLikeSchema<BookmarkImportRequest>;
export type BookmarkImportResponse = { imported: number; skipped: number };
export declare const BookmarkImportResponse: ZodLikeSchema<BookmarkImportResponse>;
/** Any source name: a shipped client keeps working when a new source appears. */
export type BookmarkState = {
  source: string;
  post_id: string;
  revision: number;
  state: "active" | "removed";
  favorited_at: number | null;
  restricted: boolean;
  metadata?: BookmarkMetadata;
};
export declare const BookmarkState: ZodLikeSchema<BookmarkState>;
export type BookmarkOperationResponse = { item: BookmarkState };
export declare const BookmarkOperationResponse: ZodLikeSchema<BookmarkOperationResponse>;
export declare const BookmarkSnapshotRequestId: ZodLikeSchema<string>;
export type BookmarkConflictResponse = {
  error: { code: "revision_conflict"; message: string };
  current: BookmarkState | null;
};
export declare const BookmarkConflictResponse: ZodLikeSchema<BookmarkConflictResponse>;
export type BookmarkChangesResponse = {
  items: { sequence: number; type: "add" | "update" | "remove"; item: BookmarkState }[];
  next_cursor: string;
  done: boolean;
};
export declare const BookmarkChangesResponse: ZodLikeSchema<BookmarkChangesResponse>;
export type BookmarkSnapshotResponse = {
  items: BookmarkState[];
  next_cursor: string | null;
  changes_cursor: string | null;
  done: boolean;
  expires_at: number;
};
export declare const BookmarkSnapshotResponse: ZodLikeSchema<BookmarkSnapshotResponse>;
