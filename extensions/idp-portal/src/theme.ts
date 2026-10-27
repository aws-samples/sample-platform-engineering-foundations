/*
 * Bootstrap do Cloudscape One Theme (CDS-1T). Roda no entrypoint, ANTES do primeiro render do React,
 * para nenhum componente pintar um frame com o tema errado. A stylesheet `one-theme.css` é importada
 * no main.tsx antes de qualquer componente; aqui só ficam as classes que ela espera no <body>.
 *
 * Flavor `oss` (CLOUDSCAPE_FLAVOR=oss, build da extensão em aws-samples): o pacote público declara
 * `Theme.OneTheme` no enum, mas não traz os estilos (medido em 24/10/2026: 16 menções em 1 arquivo
 * contra 858 em 30 no pacote interno). Aplicar a classe lá só desligaria estilos base sem repor nada,
 * então o build público fica no tema padrão do Cloudscape open source (Visual Refresh).
 */
import { applyDensity, applyMode, Density, Mode, setThemeClass, Theme } from '@cloudscape-design/global-styles';

export const FLAVOR: 'internal' | 'oss' = import.meta.env.VITE_CLOUDSCAPE_FLAVOR === 'oss' ? 'oss' : 'internal';
export const THEME = FLAVOR === 'oss' ? Theme.VisualRefresh : Theme.OneTheme;
export const MODE = Mode.Light;
export const DENSITY = Density.Comfortable;

export function bootstrapTheme(target: Element = document.body): void {
  setThemeClass(THEME, target);
  applyMode(MODE, target);
  applyDensity(DENSITY, target);
}
