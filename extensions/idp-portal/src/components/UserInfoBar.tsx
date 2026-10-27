import { useState, useEffect } from 'react';
import Box from '@cloudscape-design/components/box';
import Icon from '@cloudscape-design/components/icon';
import { colorBackgroundLayoutMain, colorBorderDividerDefault, spaceScaledL, spaceScaledXs, spaceScaledXxs } from '@cloudscape-design/design-tokens';

// the internal gateway provides user info via window.harmony.api.user (the corporate SSO-authenticated).
// Types come from the gateway's type package (already in node_modules from template).

export function UserInfoBar(): JSX.Element | null {
  const [displayName, setDisplayName] = useState<string | null>(null);

  useEffect(() => {
    // window.harmony is injected by the the internal gateway runtime at load time
    const h = (window as any).harmony;
    if (h?.api?.user?.getUser) {
      h.api.user.getUser()
        .then((u: { firstName: string; lastName: string; login: string }) => {
          setDisplayName(`${u.firstName} ${u.lastName} (${u.login})`);
        })
        .catch(() => {});
    }
  }, []);

  if (!displayName) return null;

  return (
    <div style={{
      display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: spaceScaledXxs,
      padding: `${spaceScaledXs} ${spaceScaledL}`,
      background: colorBackgroundLayoutMain, borderBottom: `1px solid ${colorBorderDividerDefault}`,
    }}>
      <Icon name="user-profile" size="small" variant="subtle" />
      <Box fontSize="body-s" color="text-body-secondary">{displayName}</Box>
    </div>
  );
}
