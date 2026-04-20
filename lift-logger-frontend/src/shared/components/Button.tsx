import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'
import styles from './Button.module.css'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

type Props = PropsWithChildren<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant
    block?: boolean
  }
>

export function Button({ children, variant = 'secondary', block, className, ...rest }: Props) {
  const cls = [styles.btn, styles[variant], block ? styles.block : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <button {...rest} className={cls}>
      {children}
    </button>
  )
}
