# Types

Custom validated types that integrate with Deepkit's type system for automatic validation and transformation during deserialization.

## Date Types

### `DateString`

MySQL DATE column type. Stored as `YYYY-MM-DD` string, validated via regex pattern.

```typescript
import { DateString } from '@signal24/dk-server-foundation';

class Event {
    date!: DateString; // MySQL DATE column
}
```

### `ValidDate`

A `Date` that rejects `Invalid Date` values during validation.

```typescript
import { ValidDate } from '@signal24/dk-server-foundation';

class Booking {
    startDate!: ValidDate;
}
```

## String Types

### `TrimmedString` / `NonEmptyTrimmedString`

Strings that are automatically trimmed during Deepkit deserialization.

```typescript
import { TrimmedString, NonEmptyTrimmedString } from '@signal24/dk-server-foundation';

class UserInput {
    name!: NonEmptyTrimmedString; // Trimmed + must be non-empty
    notes!: TrimmedString; // Trimmed, can be empty
}
```

### `EmailAddress`

Regex-validated email address:

```typescript
import { EmailAddress } from '@signal24/dk-server-foundation';

class User {
    email!: EmailAddress; // Validated against /^[a-z0-9_+.-]+@[a-z0-9-.]+\.[a-z]+$/i
}
```

## Phone Types

Validated phone numbers using Google's libphonenumber library. Automatically cleaned and validated during Deepkit deserialization.

### `PhoneNumber`

International E.164 format with `+` prefix:

```typescript
import { PhoneNumber } from '@signal24/dk-server-foundation';

class Contact {
    phone!: PhoneNumber; // e.g., '+15551234567'
}
```

### `PhoneNumberNANP`

North American Numbering Plan format (US/Canada) without the `+1` prefix:

```typescript
import { PhoneNumberNANP } from '@signal24/dk-server-foundation';

class Contact {
    phone!: PhoneNumberNANP; // e.g., '5551234567'
}
```

### Phone Utilities

```typescript
import { cleanPhone, formatPhoneFriendly } from '@signal24/dk-server-foundation';

// Clean and validate (returns null if invalid)
cleanPhone('(555) 123-4567'); // '+15551234567'
cleanPhone('555-1234567', 'US'); // '+15551234567'
cleanPhone('invalid'); // null

// Format for display
formatPhoneFriendly('+15551234567'); // '(555) 123-4567'
formatPhoneFriendly('+15551234567', 'US'); // '(555) 123-4567'
```

## Database Types

### `Coordinate`

MySQL POINT geometry type:

```typescript
import { Coordinate, MySQLCoordinate, NullableMySQLCoordinate } from '@signal24/dk-server-foundation';

class Location {
    coords!: MySQLCoordinate; // NOT NULL POINT column
    altCoords!: NullableMySQLCoordinate; // NULLABLE POINT column
}

// Usage
const loc = new Location();
loc.coords = { x: -73.9857, y: 40.7484 }; // longitude, latitude
```

### `UuidString`

Type annotation for UUID string fields:

```typescript
import { UuidString } from '@signal24/dk-server-foundation';

class Resource {
    id!: UuidString;
}
```

### `Length<N>`

Fixed-length string validator:

```typescript
import { Length } from '@signal24/dk-server-foundation';

class VerificationCode {
    code!: Length<6>; // Must be exactly 6 characters
}
```

### `OnUpdate<T>`

MySQL `ON UPDATE` column expression annotation. Used by `migration:create` to generate and detect `ON UPDATE` clauses:

```typescript
import { OnUpdate } from '@signal24/dk-server-foundation';

class User {
    updatedAt!: Date & OnUpdate<'CURRENT_TIMESTAMP'>; // ON UPDATE CURRENT_TIMESTAMP
}
```

This is MySQL-only. The annotation is ignored on PostgreSQL.

### `HasDefault`

Mark fields with application-level defaults so they become optional in entity creation:

```typescript
import { HasDefault } from '@signal24/dk-server-foundation';

class User {
    role!: string & HasDefault; // Optional in createEntity/createPersistedEntity
}
```

## Utility Types

### Primitives

```typescript
type ConcretePrimitive = string | number | boolean;
type DefinedPrimitive = ConcretePrimitive | null;
type Primitive = DefinedPrimitive | undefined;
type StrictBool = true | false;
```

### Object Types

```typescript
type KVObject<T = any> = Record<string, T>;
type NestedKVObject<T = any> = KVObject<T | T[] | KVObject<T>>;
type Serializable<T = ConcretePrimitive> = T | T[] | NestedKVObject<T> | NestedKVObject<T>[];
```

### Field Manipulation

```typescript
// Make specific fields required
type RequireFields<T, K extends keyof T> = T & { [P in K]-?: T[P] };

// Get keys where values match a type
type ObjectKeysMatching<O, V> = { [K in keyof O]: O[K] extends V ? K : never }[keyof O];
```

### Function Types

```typescript
type ArrowFunction = (...args: any) => any;
type ArrowFunctionNoArgs = () => any;
type VoidFunction = () => void;
```

### Method Extraction

```typescript
// Get only the method keys of a type
type MethodKeys<T> = keyof MethodsOf<T>;

// Get an object with only the methods
type MethodsOf<T> = { [K in keyof T as IsFunction<T[K]> extends never ? never : K]: T[K] };
```
