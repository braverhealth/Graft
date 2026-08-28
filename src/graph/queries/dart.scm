; Dart — breadth-tier tags.scm
;
; The Dart grammar does not wrap a function's signature and body in one
; definition node: `function_signature` / `method_signature` sit as siblings
; of `function_body` under `program` / `class_body`. Graft's generic extractor
; expands a captured signature to include a following `function_body` sibling
; so calls inside the body are attributed to the function (see defScope).
;
; Without this query the node-kind walker fallback runs, which:
;   - skips `function_signature` (type does not match the walker suffixes)
;   - mints `class_body` as a class (type starts with "class") named after the
;     first identifier in the body (`int`, `bool`, …)
;   - mints function-body locals (`initialized_variable_definition`) as symbols
;
; Call sites are `identifier` + adjacent `selector`/`argument_part`, not a
; `call_expression` node. Only that shape is tagged — assignment selectors and
; bare identifier reads are left alone.

; Types ---------------------------------------------------------------------

(class_definition
  name: (identifier) @name) @definition.class

(mixin_declaration
  (identifier) @name) @definition.interface

(extension_declaration
  name: (identifier) @name) @definition.class

(enum_declaration
  name: (identifier) @name) @definition.enum

(enum_constant
  name: (identifier) @name) @definition.constant

(type_alias
  (type_identifier) @name) @definition.type

; Members -------------------------------------------------------------------

(method_signature
  (function_signature
    name: (identifier) @name)) @definition.method

(method_signature
  (getter_signature
    name: (identifier) @name)) @definition.method

(method_signature
  (setter_signature
    name: (identifier) @name)) @definition.method

(declaration
  (constructor_signature
    name: (identifier) @name)) @definition.method

(declaration
  (function_signature
    name: (identifier) @name)) @definition.method

(declaration
  (initialized_identifier_list
    (initialized_identifier
      (identifier) @name))) @definition.property

(declaration
  (static_final_declaration_list
    (static_final_declaration
      (identifier) @name))) @definition.constant

; Top level -----------------------------------------------------------------

(program
  (function_signature
    name: (identifier) @name) @definition.function)

(program
  (static_final_declaration_list
    (static_final_declaration
      (identifier) @name) @definition.constant))

; Calls ---------------------------------------------------------------------

(_
  (identifier) @name @reference.call
  .
  (selector (argument_part)))

(_
  (selector
    (unconditional_assignable_selector
      (identifier) @name @reference.call))
  .
  (selector (argument_part)))

; Supertypes ----------------------------------------------------------------

(superclass
  (type_identifier) @name) @reference.class

(mixins
  (type_identifier) @name) @reference.class

(interfaces
  (type_identifier) @name) @reference.interface
