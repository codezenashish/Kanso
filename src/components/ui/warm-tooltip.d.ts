import type { ComponentType, ReactElement, ReactNode, Ref } from 'react';

export type WarmTooltipProps = {
  children: ReactElement;
  content: ReactNode;
  shortcut?: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  warmWindow?: number;
  surfaceColor?: string;
  inkColor?: string;
  size?: 'sm' | 'md' | 'lg';
  radius?: number;
  gap?: number;
  arrow?: boolean;
  popDuration?: number;
  popScale?: number;
  popBlur?: number;
  showFuse?: boolean;
  longPress?: number;
  disabled?: boolean;
  className?: string;
};

export const WarmTooltipGroup: ComponentType<{
  children: ReactNode;
  delay?: number;
  warmWindow?: number;
  travel?: number;
  lean?: number;
  onWarmChange?: (warm: boolean) => void;
  ref?: Ref<{ reset: () => void }>;
}>;

export default function WarmTooltip(props: WarmTooltipProps): ReactElement;
