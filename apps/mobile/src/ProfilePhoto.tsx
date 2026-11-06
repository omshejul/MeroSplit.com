import React from 'react';
import PhotoEditor, { type PhotoEditorProps } from './PhotoEditor';
export type ProfilePhotoProps = Omit<PhotoEditorProps, 'group' | 'editable'>;
export default function ProfilePhoto(props: ProfilePhotoProps) { return <PhotoEditor {...props} />; }
