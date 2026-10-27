import { useNavigate } from 'react-router-dom';

/** Mesmo critério que o shell já usava: caminho começando com http abre fora do SPA. */
export const isExternal = (path: string): boolean => path.startsWith('http');

/**
 * `onFollow` para Link do Cloudscape: caminho interno navega pelo react-router, sem recarregar a página;
 * externo segue o href. O Cloudscape só dispara onFollow em clique sem modificador, então abrir em nova
 * aba continua com o navegador.
 */
export function useRouterFollow(): (path: string) => (event: { preventDefault(): void }) => void {
  const navigate = useNavigate();
  return path => event => {
    if (isExternal(path)) return;
    event.preventDefault();
    navigate(path);
  };
}
