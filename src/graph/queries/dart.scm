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
