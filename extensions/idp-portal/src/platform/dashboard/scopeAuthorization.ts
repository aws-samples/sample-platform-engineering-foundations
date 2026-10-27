import { roleAllows, ScopeContext } from '../scope/scopeModel';
import { WidgetId, WIDGET_IDS, WIDGET_REGISTRY } from './widgetRegistry';

export function authorizedWidgetsFrom(context: ScopeContext, activeProject: string | null): ReadonlySet<WidgetId> {
  const projects = context.projects.filter(project => project.lifecycle.state !== 'retired');
  const selected = activeProject === null ? projects : projects.filter(project => project.id === activeProject);
  const visible = WIDGET_IDS.filter(widgetId => {
    const capability = WIDGET_REGISTRY[widgetId].requiredCapability;
    return capability === 'project:read' && selected.some(project => roleAllows(project.role, 'read'));
  });
  return new Set(visible);
}
