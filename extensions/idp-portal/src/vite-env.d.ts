/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'oss' no build da extensão aws-samples (CLOUDSCAPE_FLAVOR=oss); ausente ou 'internal' no the internal gateway. */
  readonly VITE_CLOUDSCAPE_FLAVOR?: 'internal' | 'oss';
  /** 'harmony' (SigV4 pelo the internal gateway, default interno) ou 'bearer' (Cognito/OIDC, default do flavor oss). */
  readonly VITE_AUTH_MODE?: 'harmony' | 'bearer';
  readonly VITE_HARMONY_ROLE_ARN?: string;
  readonly VITE_CLUSTER_API_URL?: string;
  readonly VITE_CLUSTER_API_REGION?: string;
  readonly VITE_PLATFORM_API_URL?: string;
  readonly VITE_PLATFORM_API_REGION?: string;
  readonly VITE_BFF_URL?: string;
  readonly VITE_BFF_REGION?: string;
}
