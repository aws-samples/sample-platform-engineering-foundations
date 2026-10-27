import TopNavigation from '@cloudscape-design/components/top-navigation';

interface HeaderProps {
  appName: string;
  showBack?: boolean;
}

// No sign-out button needed: the internal gateway apps use the corporate SSO session (browser-wide).
// Users sign out of the corporate SSO itself, not individual apps.
// A barra é o TopNavigation do Cloudscape: cor, contraste e foco vêm do One Theme, não deste arquivo.
export function Header({ appName, showBack = false }: HeaderProps): JSX.Element {
  return (
    <TopNavigation
      identity={{ href: '/', title: appName }}
      utilities={showBack ? [{ type: 'button', text: 'Portal', href: '/', iconName: 'arrow-left', ariaLabel: 'Back to Portal' }] : []}
    />
  );
}
