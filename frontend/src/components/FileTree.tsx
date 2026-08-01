import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  ChevronRight, ChevronDown, Folder, FolderOpen,
  Plus, Trash2, Edit3
} from 'lucide-react';

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  path: string;
  children?: FileNode[];
  size?: number;
  modified?: string;
}

interface FileTreeProps {
  files: FileNode[];
  selectedFile?: string;
  onFileSelect?: (file: FileNode) => void;
  onFileCreate?: (parentPath: string, type: 'file' | 'folder') => void;
  onFileDelete?: (file: FileNode) => void;
  onFileRename?: (file: FileNode, newName: string) => void;
  className?: string;
}

function FileTreeNode({ 
  node, 
  level = 0, 
  selectedFile, 
  onFileSelect, 
  onFileCreate, 
  onFileDelete, 
  onFileRename 
}: {
  node: FileNode;
  level?: number;
  selectedFile?: string;
  onFileSelect?: (file: FileNode) => void;
  onFileCreate?: (parentPath: string, type: 'file' | 'folder') => void;
  onFileDelete?: (file: FileNode) => void;
  onFileRename?: (file: FileNode, newName: string) => void;
}) {
  const [expanded, setExpanded] = useState(level < 2);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(node.name);

  const isSelected = selectedFile === node.id;
  const hasChildren = node.children && node.children.length > 0;

  const handleClick = () => {
    if (node.type === 'folder') {
      setExpanded(!expanded);
    }
    onFileSelect?.(node);
  };

  const handleRename = () => {
    if (editName.trim() && editName !== node.name) {
      onFileRename?.(node, editName.trim());
    }
    setEditing(false);
  };

  const getFileIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'js':
      case 'jsx':
      case 'ts':
      case 'tsx':
        return '📄';
      case 'json':
        return '⚙️';
      case 'md':
        return '📝';
      case 'css':
      case 'scss':
        return '🎨';
      case 'html':
        return '🌐';
      case 'py':
        return '🐍';
      case 'jpg':
      case 'png':
      case 'gif':
        return '🖼️';
      default:
        return '📄';
    }
  };

  return (
    <>
      <motion.div
        className={`flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer select-none transition-colors group
          ${isSelected ? 'accent-active' : 'hover:bg-white/5'}
        `}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={handleClick}
        initial={false}
        whileHover={{ x: 2 }}
        role="treeitem"
        tabIndex={editing ? -1 : 0}
        aria-selected={isSelected}
        aria-expanded={node.type === 'folder' ? expanded : undefined}
        aria-label={`${node.type} ${node.name}`}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleClick();
          } else if (event.key === 'ArrowRight' && node.type === 'folder' && !expanded) {
            event.preventDefault();
            setExpanded(true);
          } else if (event.key === 'ArrowLeft' && node.type === 'folder' && expanded) {
            event.preventDefault();
            setExpanded(false);
          } else if (event.key === 'F2') {
            event.preventDefault();
            setEditing(true);
          }
        }}
      >
        {/* Expansion indicator */}
        <div className="w-4 h-4 flex items-center justify-center">
          {node.type === 'folder' && hasChildren && (
            expanded ? 
              <ChevronDown className="w-3 h-3 text-gray-400" /> : 
              <ChevronRight className="w-3 h-3 text-gray-400" />
          )}
        </div>

        {/* Icon */}
        <div className="w-4 h-4 flex items-center justify-center text-xs">
          {node.type === 'folder' ? (
            expanded ? <FolderOpen className="w-4 h-4 text-blue-400" /> : <Folder className="w-4 h-4 text-blue-400" />
          ) : (
            <span>{getFileIcon(node.name)}</span>
          )}
        </div>

        {/* Name */}
        {editing ? (
          <input
            value={editName}
            aria-label={`Rename ${node.type} ${node.name}`}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-800 text-white px-2 py-1 rounded text-sm flex-1 min-w-0"
            autoFocus
            onFocus={(e) => e.target.select()}
          />
        ) : (
          <span className="flex-1 truncate text-sm">{node.name}</span>
        )}

        {/* Actions */}
        <AnimatePresence>
          {!editing && (
            <motion.div 
              className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
            >
              {node.type === 'folder' && (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFileCreate?.(node.path, 'file');
                    }}
                    className="size-7 inline-flex items-center justify-center rounded hover:bg-white/10 focus-visible:opacity-100"
                    title="New file"
                    aria-label={`Create file in ${node.name}`}
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFileCreate?.(node.path, 'folder');
                    }}
                    className="size-7 inline-flex items-center justify-center rounded hover:bg-white/10 focus-visible:opacity-100"
                    title="New folder"
                    aria-label={`Create folder in ${node.name}`}
                  >
                    <Folder className="w-3 h-3" />
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(true);
                }}
                className="size-7 inline-flex items-center justify-center rounded hover:bg-white/10 focus-visible:opacity-100"
                title="Rename"
                aria-label={`Rename ${node.type} ${node.name}`}
              >
                <Edit3 className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onFileDelete?.(node);
                }}
                className="size-7 inline-flex items-center justify-center rounded hover:bg-red-500/20 text-red-400 focus-visible:opacity-100"
                title="Delete"
                aria-label={`Delete ${node.type} ${node.name}`}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Children */}
      <AnimatePresence>
        {expanded && node.children && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
            role="group"
          >
            {node.children.map(child => (
              <FileTreeNode
                key={child.id}
                node={child}
                level={level + 1}
                selectedFile={selectedFile}
                onFileSelect={onFileSelect}
                onFileCreate={onFileCreate}
                onFileDelete={onFileDelete}
                onFileRename={onFileRename}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default function FileTree({ 
  files, 
  selectedFile, 
  onFileSelect, 
  onFileCreate, 
  onFileDelete, 
  onFileRename,
  className = '' 
}: FileTreeProps) {
  return (
    <div className={`space-y-1 ${className}`} role="tree" aria-label="File tree">
      {files.map(file => (
        <FileTreeNode
          key={file.id}
          node={file}
          selectedFile={selectedFile}
          onFileSelect={onFileSelect}
          onFileCreate={onFileCreate}
          onFileDelete={onFileDelete}
          onFileRename={onFileRename}
        />
      ))}
    </div>
  );
}
