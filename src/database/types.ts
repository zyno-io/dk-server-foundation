import { TypeAnnotation } from '@deepkit/core';
import { MySQL, Type, Validate, ValidatorError } from '@deepkit/type';

export declare type UuidString = string & TypeAnnotation<'dksf:type', 'uuid'>;

/**
 * Unsigned integer column. Plain `number` maps to a signed INT; use this when the column is
 * `INT UNSIGNED` (MySQL). On PostgreSQL it is an ordinary INT (no unsigned concept).
 */
export type UnsignedNumber = number & MySQL<{ type: 'int unsigned' }>;

export class Coordinate {
    x!: number;
    y!: number;
}
export type MySQLCoordinate = Coordinate & MySQL<{ type: 'point' }>;
export type NullableMySQLCoordinate = (Coordinate | null) & MySQL<{ type: 'point' }>;

function _validateLength(value: string, _type: Type, length: number) {
    if (typeof value === 'string' && value.length !== length) {
        return new ValidatorError('invalidLength', `Value must be exactly ${length} characters long.`);
    }
}
export declare type Length<T extends number> = string & Validate<typeof _validateLength, T> & TypeAnnotation<'dksf:length', T>;
