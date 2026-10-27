// Schema -> form model. The ONE function that decides how a capability schema.json becomes form
// controls, so the Studio preview and the provisioning wizard render the same thing after merge
// (issue #11: "Preview do formulário é idêntico ao render usado no wizard após merge").
//
// Pure and closed: a schema keyword this file does not know is ignored, never interpreted, and a
// property type it does not know becomes an `unsupported` control the UI shows as such instead of
// a free-text box that would let a value outside the contract through.

export type ControlKind = 'text' | 'number' | 'select' | 'toggle' | 'keyValue' | 'list' | 'unsupported';

export interface SchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  examples?: unknown[];
}

export interface CapabilitySchema {
  title?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaProperty>;
  additionalProperties?: boolean | object;
}

export interface FormFieldModel {
  name: string;
  label: string;
  description: string;
  control: ControlKind;
  required: boolean;
  defaultValue: unknown;
  options: string[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  placeholder: string;
}

export type FormValues = Record<string, unknown>;

function controlFor(prop: SchemaProperty): ControlKind {
  switch (prop.type) {
    case 'string': return Array.isArray(prop.enum) && prop.enum.length ? 'select' : 'text';
    case 'integer': return 'number';
    case 'boolean': return 'toggle';
    case 'object': return 'keyValue';
    case 'array': return 'list';
    default: return 'unsupported';
  }
}

function humanize(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formModelFromSchema(schema: CapabilitySchema): FormFieldModel[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => {
    const example = Array.isArray(prop.examples) && prop.examples.length ? prop.examples[0] : undefined;
    return {
      name,
      label: prop.title || humanize(name),
      description: prop.description ?? '',
      control: controlFor(prop),
      required: required.has(name),
      defaultValue: prop.default,
      options: Array.isArray(prop.enum) ? prop.enum.map(String) : [],
      pattern: prop.pattern,
      minimum: prop.minimum,
      maximum: prop.maximum,
      placeholder: example === undefined ? '' : typeof example === 'string' ? example : JSON.stringify(example),
    };
  });
}

export function initialValues(fields: FormFieldModel[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) if (field.defaultValue !== undefined) values[field.name] = field.defaultValue;
  return values;
}

export interface FieldError { name: string; code: 'required' | 'pattern' | 'enum' | 'type' | 'range' | 'unknown_field' }

/** Same rules the JSON Schema enforces, so the user sees the CI verdict before proposing. */
export function validateValues(fields: FormFieldModel[], values: FormValues): FieldError[] {
  const errors: FieldError[] = [];
  const known = new Set(fields.map(f => f.name));
  for (const name of Object.keys(values)) if (!known.has(name)) errors.push({ name, code: 'unknown_field' });
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || value === '') {
      if (field.required) errors.push({ name: field.name, code: 'required' });
      continue;
    }
    if (field.control === 'text' || field.control === 'select') {
      if (typeof value !== 'string') { errors.push({ name: field.name, code: 'type' }); continue; }
      if (field.control === 'select' && !field.options.includes(value)) errors.push({ name: field.name, code: 'enum' });
      else if (field.pattern && !new RegExp(field.pattern).test(value)) errors.push({ name: field.name, code: 'pattern' });
    } else if (field.control === 'number') {
      if (typeof value !== 'number' || !Number.isInteger(value)) { errors.push({ name: field.name, code: 'type' }); continue; }
      if ((field.minimum !== undefined && value < field.minimum) || (field.maximum !== undefined && value > field.maximum)) {
        errors.push({ name: field.name, code: 'range' });
      }
    } else if (field.control === 'toggle' && typeof value !== 'boolean') {
      errors.push({ name: field.name, code: 'type' });
    } else if (field.control === 'keyValue' && (typeof value !== 'object' || Array.isArray(value) || value === null
      || Object.values(value).some(v => typeof v !== 'string'))) {
      errors.push({ name: field.name, code: 'type' });
    } else if (field.control === 'list' && (!Array.isArray(value) || value.some(v => typeof v !== 'string'))) {
      errors.push({ name: field.name, code: 'type' });
    } else if (field.control === 'unsupported') {
      errors.push({ name: field.name, code: 'type' });
    }
  }
  return errors;
}
