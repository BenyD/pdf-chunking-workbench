'use client';

import {CopyMode, type CopyModeProps} from '@/components/quartz/ui/input/copy';
import {NumberMode, autoStep, type NumberModeProps} from '@/components/quartz/ui/input/number';
import {OtpMode, type OtpModeProps} from '@/components/quartz/ui/input/otp';
import {InputAction, InputControl, InputPrefix, InputRoot, InputSuffix, splitBox, type BoxProps, type InputRootProps, type NativeProps, type StringValue} from '@/components/quartz/ui/input/parts';
import {PasswordMode, generatePassword, type PasswordModeProps} from '@/components/quartz/ui/input/password';
import {SearchMode, type SearchModeProps} from '@/components/quartz/ui/input/search';
import {SecretMode, maskSecret, type SecretModeProps} from '@/components/quartz/ui/input/secret';

// Quartz's input: one line of text, on Base UI's Input, NumberField and OTPField. Every
// mode sits in one field box (fieldBoxVariants), so they share a height, a hover edge, a fail edge and an
// ink focus edge, and an icon, unit or button in the prefix or suffix slot is inside the edge and a click on
// it focuses the text (trap/field-affix-focus).
//
// Modes (was Input group, Password input, Secret input, Copy input, Search field, Number field, Input OTP
// and Secret reveal):
//   text      any native type, with prefix and suffix slots
//   password  masked, a reveal toggle, and an optional generator for new passwords
//   secret    an API key or token in mono, masked until revealed. Read-only, it keeps its prefix and last
//             four characters visible so keys tell apart, and copies the real value while hidden
//   copy      a read-only value with Copy in the suffix; a click selects all of it
//   search    a magnifier, a clear button once there is a query, a shortcut hint while empty
//   number    Base UI NumberField: role spinbutton, steppers, a unit, limits that clamp
//   otp       one slot per character; paste fills every slot
//
// The considered detail: with step="auto", a number steps by its second significant digit, so 40 moves
// by 1, 250 by 10 and 1,200 by 100. Each step is reversible across a power of ten (1,000 down is 990,
// 990 up is 1,000), and the field shows the step it will take while focused.
//
// An editable secret that is revealed turns its edge to the key line (data-kind="key"), so a visible secret is
// obvious from across the room.
//
// Each mode lives in its own file under input/ (parts.tsx holds the box and what the modes share); this file
// picks the mode and is the one import.

type TextModeProps = BoxProps & NativeProps & StringValue & {
  mode?: 'text';
  /** Any native text type: text, email, url, tel, file. */
  type?: string;
};

type InputProps = TextModeProps | PasswordModeProps | SecretModeProps | CopyModeProps | SearchModeProps | NumberModeProps | OtpModeProps;
type InputMode = NonNullable<InputProps['mode']>;

// ---------- Input ----------

function Input(props: InputProps) {
  switch (props.mode) {
    case 'password': return <PasswordMode {...props}/>;
    case 'secret': return <SecretMode {...props}/>;
    case 'copy': return <CopyMode {...props}/>;
    case 'search': return <SearchMode {...props}/>;
    case 'number': return <NumberMode {...props}/>;
    case 'otp': return <OtpMode {...props}/>;
    default: return <TextMode {...props}/>;
  }
}

function TextMode({mode: _mode, size = 'default', prefix, suffix, className, controlClassName, disabled, readOnly, type = 'text', ...all}: TextModeProps) {
  const {box, rest} = splitBox(all);
  return <InputRoot size={size} disabled={disabled} readOnly={readOnly} invalid={rest['aria-invalid'] === true || rest['aria-invalid'] === 'true'} className={className} data-mode="text" {...box}>
    {prefix !== undefined && <InputPrefix>{prefix}</InputPrefix>}
    <InputControl type={type} disabled={disabled} readOnly={readOnly} className={controlClassName} {...rest}/>
    {suffix !== undefined && <InputSuffix>{suffix}</InputSuffix>}
  </InputRoot>;
}

export {
  Input,
  InputAction,
  InputControl,
  InputPrefix,
  InputRoot,
  InputSuffix,
  autoStep,
  generatePassword,
  maskSecret,
  type InputMode,
  type InputProps,
  type InputRootProps,
  type SearchModeProps,
};
