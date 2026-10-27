import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Public shape of the IDP portal (aws-samples extension): one flavor. The SPA talks to API Gateway
// with a Cognito access token (VITE_AUTH_MODE=bearer) and the Cloudscape Visual Refresh theme.
// API URLs and the Cognito client come from VITE_* at build time; scripts/deploy.sh fills them from
// the Terraform outputs.
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_CLOUDSCAPE_FLAVOR': JSON.stringify('oss'),
    'import.meta.env.VITE_AUTH_MODE': JSON.stringify(process.env.VITE_AUTH_MODE ?? 'bearer'),
  },
  build: { outDir: 'build' },
});
