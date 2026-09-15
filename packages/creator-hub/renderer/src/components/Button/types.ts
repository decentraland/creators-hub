import type { ButtonProps as DclButtonProps } from 'decentraland-ui2';

export type ButtonProps = DclButtonProps & {
  className?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
};

export type GroupProps = ButtonProps & {
  extra: React.ReactNode;
  tooltip?: string;
  extraTooltip?: string;
};
