
# Logical gates defined as simple functions

Logical gates (AND, NAND, OR, NOR, XOR, XNOR, NOT) made available as functions for ease of use in functional programming styles. An example, reducing an array to a single boolean value:

```javascript
var gates = requrie('logic-gates');

[true, true, true].reduce(gates.and);  // true
[true, false, true].reduce(gates.and);  // false
[false, false, false].reduce(gates.and);  // false
```

## Install

```bash
$ npm install [--save] logic-gates
```

## Usage

The defined logical gate methods are fast, accurate, and work on any type of input.

```javascript
var gates = require('logic-gates');

gates.and(true, false);  // false
gates.nand(true, false);  // true
gates.not.and(true, false);  // true

gates.or(true, false);  // true
gates.nor(true, false);  // false
gates.not.or(true, false);  // false

gates.xor(true, false);  // true
gates.xnor(true, false);  // false
gates.not.xor(true, false);  // false

gates.not(true);  // false
gates.not(false);  // true
```
