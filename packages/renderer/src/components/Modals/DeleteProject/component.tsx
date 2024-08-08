import { useCallback } from 'react';
import { Modal } from 'decentraland-ui2/dist/components/Modal/Modal';

import { t } from '/@/modules/store/translation/utils';

import { Button } from '../../Button';

import type { Props } from './types';

export function DeleteProject({ open, project, onClose, onSubmit }: Props) {
  const handleSubmit = useCallback(() => {
    onSubmit(project);
  }, []);

  return (
    <Modal
      open={open}
      title={t('modal.delete_project.title', { title: project.title })}
      onClose={onClose}
      size="tiny"
      actions={
        <>
          <Button
            color="secondary"
            onClick={onClose}
          >
            {t('modal.cancel')}
          </Button>
          <Button onClick={handleSubmit}>{t('modal.confirm')}</Button>
        </>
      }
    >
      {project.isImported
        ? t('modal.delete_project.remove_imported_scene', { title: project.title })
        : t('modal.delete_project.irreversible_operation')}
    </Modal>
  );
}
