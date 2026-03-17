import ImagePickerCropper from './ImagePickerCropper';

interface AvatarEditorProps {
  isOpen: boolean;
  onClose: () => void;
  onSaved: (avatarUrl: string | null) => void;
  currentAvatarUrl: string | null;
  uploadEndpoint?: string;
}

export default function AvatarEditor({ isOpen, onClose, onSaved, currentAvatarUrl, uploadEndpoint = '/users/me/avatar' }: AvatarEditorProps) {
  return (
    <ImagePickerCropper
      isOpen={isOpen}
      onClose={onClose}
      onSaved={onSaved}
      currentImageUrl={currentAvatarUrl}
      uploadEndpoint={uploadEndpoint}
      deleteEndpoint={uploadEndpoint}
      fieldName="avatar"
      title="Edit Avatar"
      shape="circle"
      responseKey="avatarUrl"
    />
  );
}
