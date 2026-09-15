import { forwardRef, useCallback, useState } from 'react';
import cx from 'classnames';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { Button as DclButton, ButtonGroup as DclButtonGroup, Tooltip } from 'decentraland-ui2';

import { Popper } from '../Popper';

import type { ButtonProps, GroupProps } from './types';

import './styles.css';

// forwardRef so a Button can be the direct child of a MUI Tooltip (which needs the DOM node).
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { children, className = '', onClick, ...props },
  ref,
) {
  return (
    <DclButton
      {...props}
      ref={ref}
      className={cx('Button', className)}
      onClick={onClick}
    >
      {children}
    </DclButton>
  );
});

// MUI refuses to attach a tooltip to a disabled button (it logs a warning and never opens),
// so a disabled button is rendered bare.
function withTooltip(
  title: string | undefined,
  disabled: boolean | undefined,
  button: React.ReactElement,
) {
  return title && !disabled ? <Tooltip title={title}>{button}</Tooltip> : button;
}

export function ButtonGroup({ extra, tooltip, extraTooltip, ...props }: GroupProps) {
  const [open, setOpen] = useState(false);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const handleToggle = useCallback((e: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(e.currentTarget);
    setOpen(prev => !prev);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
    setAnchorEl(null);
  }, []);

  return (
    <>
      <DclButtonGroup variant="contained">
        {withTooltip(tooltip, props.disabled, <Button {...props} />)}
        {withTooltip(
          extraTooltip,
          props.disabled,
          <Button
            className="extra-button"
            color={props.color}
            size="small"
            disabled={props.disabled}
            onClick={handleToggle}
          >
            <ArrowDropDownIcon />
          </Button>,
        )}
        {open && (
          <Popper
            open={open}
            onClose={handleClose}
            anchorEl={anchorEl}
            placement="bottom-end"
          >
            {extra}
          </Popper>
        )}
      </DclButtonGroup>
    </>
  );
}
