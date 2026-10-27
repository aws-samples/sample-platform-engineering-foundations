import {
  BarChartIcon,
  ClipboardIcon,
  LockIcon,
  GraduationCapIcon,
  RefreshIcon,
  ShieldIcon,
  GlobeIcon,
  UsersIcon,
  TrendingUpIcon,
  FileTextIcon,
  DollarIcon,
  NewspaperIcon,
  SunIcon,
  CalendarIcon,
  TargetIcon,
  BookmarkIcon,
  BookOpenIcon,
  BrainIcon,
  MessageCircleIcon,
  WrenchIcon,
  GitBranchIcon,
  NetworkIcon,
  ShuffleIcon,
  HomeIcon,
  ArrowLeftIcon,
} from './Icons';
import { colorTextLinkDefault } from '@cloudscape-design/design-tokens';

const ICON_MAP: Record<string, (props: { size?: number; color?: string }) => JSX.Element> = {
  'bar-chart': BarChartIcon,
  'clipboard': ClipboardIcon,
  'lock': LockIcon,
  'graduation-cap': GraduationCapIcon,
  'refresh': RefreshIcon,
  'shield': ShieldIcon,
  'globe': GlobeIcon,
  'users': UsersIcon,
  'trending-up': TrendingUpIcon,
  'file-text': FileTextIcon,
  'dollar': DollarIcon,
  'newspaper': NewspaperIcon,
  'sun': SunIcon,
  'calendar': CalendarIcon,
  'target': TargetIcon,
  'bookmark': BookmarkIcon,
  'book-open': BookOpenIcon,
  'brain': BrainIcon,
  'message-circle': MessageCircleIcon,
  'wrench': WrenchIcon,
  'git-branch': GitBranchIcon,
  'network': NetworkIcon,
  'shuffle': ShuffleIcon,
  'home': HomeIcon,
  'arrow-left': ArrowLeftIcon,
};

/**
 * O SVG desenha em currentColor e a cor vai no CSS do wrapper: assim `color` aceita um design token
 * (`var(--...)`), que atributo de apresentação do SVG não resolve.
 */
export function RenderIcon({ name, size = 20, color = colorTextLinkDefault }: { name: string; size?: number; color?: string }): JSX.Element {
  const IconComponent = ICON_MAP[name] ?? FileTextIcon;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', color }} aria-hidden="true">
      <IconComponent size={size} color="currentColor" />
    </span>
  );
}
