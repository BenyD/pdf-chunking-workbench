'use client';

import {useState, type ChangeEvent} from 'react';
import {Icon, Renew, View, ViewOff} from '@/components/quartz/icon';
import {cn} from '@/lib/quartz/utils';
import {InputAction, InputControl, InputPrefix, InputRoot, InputSuffix, splitBox, useControllable, useOff, type BoxProps, type NativeProps, type StringValue} from '@/components/quartz/ui/input/parts';

type PasswordModeProps = BoxProps & NativeProps & StringValue & {
  mode: 'password';
  /** Adds Generate. Use for new passwords only, never sign-in. Pass a function to use your own generator. */
  generate?: boolean | (() => string);
  defaultRevealed?: boolean;
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%';

/** A random password from the crypto RNG, without look-alike characters (0, O, 1, l, I). */
function generatePassword(length = 24) {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}

function PasswordMode({mode: _mode, size = 'default', prefix, suffix: _suffix, className, controlClassName, value, defaultValue = '', onValueChange, onChange, generate, defaultRevealed = false, disabled: disabledProp, autoComplete, ...all}: PasswordModeProps) {
  const disabled = useOff(disabledProp);
  const {box, rest} = splitBox(all);
  const [current, set] = useControllable(value, defaultValue, onValueChange);
  const [revealed, setRevealed] = useState(defaultRevealed);
  const make = typeof generate === 'function' ? generate : () => generatePassword();
  return <InputRoot size={size} disabled={disabled} invalid={rest['aria-invalid'] === true || rest['aria-invalid'] === 'true'} className={className} data-mode="password" {...box}>
    {prefix !== undefined && <InputPrefix>{prefix}</InputPrefix>}
    <InputControl
      type={revealed ? 'text' : 'password'}
      value={current}
      onChange={(e: ChangeEvent<HTMLInputElement>) => { set(e.target.value); onChange?.(e as never); }}
      disabled={disabled}
      autoComplete={autoComplete ?? (generate ? 'new-password' : 'current-password')}
      autoCapitalize="off"
      spellCheck={false}
      className={cn(revealed && 'type-code pointer-coarse:type-code-touch', controlClassName)}
      {...rest}
    />
    <InputSuffix>
      {generate && <InputAction size="text" disabled={disabled} onClick={() => { set(make()); setRevealed(true); }}>
        <Icon icon={Renew} size={16}/>Generate
      </InputAction>}
      <InputAction
        disabled={disabled}
        aria-pressed={revealed}
        aria-label={revealed ? 'Hide password' : 'Show password'}
        onClick={() => setRevealed(r => !r)}
      ><Icon icon={revealed ? ViewOff : View} size={16}/></InputAction>
    </InputSuffix>
  </InputRoot>;
}

export {PasswordMode, generatePassword, type PasswordModeProps};
