import type { FieldDescriptor, Params, TypedParamSchema } from '../types';

/**
 * Declare a field: its params schema is checked against its params type
 * (each choice lists only values of that param), and `compute()` gets typed
 * params. The registry then holds it as a plain `FieldDescriptor`.
 */
export function defineField<P extends Params>(
  d: FieldDescriptor<P> & { params: TypedParamSchema<P> },
): FieldDescriptor<P> {
  return d;
}

/** The target param every target field has: null follows the strip's target. */
export const TARGET_PARAM = { kind: 'target', label: 'Target' } as const;

/** True or magnetic north (owner Q9: true by default). */
export const REFERENCE_PARAM = {
  kind: 'choice',
  label: 'North',
  hint: 'Magnetic subtracts the declination here',
  options: [
    { value: 'true', label: 'True' },
    { value: 'magnetic', label: 'Magnetic' },
  ],
} as const;

export type NorthReference = 'true' | 'magnetic';
