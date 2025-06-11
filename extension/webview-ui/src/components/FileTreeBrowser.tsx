import React, { useEffect, useRef, useState } from 'react';
import { FileTreeBrowserProps, FileTreeNode } from '../types/contextMentions';
import './FileTreeBrowser.css';

// Declare vscode API
declare const vscode: any;

const FileTreeBrowser: React.FC<FileTreeBrowserProps> = ({
    visible,
    onSelect,
    onClose,
    title = 'Select File or Directory'
}) => {
    const [tree, setTree] = useState<FileTreeNode[]>([]);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
    const [loading, setLoading] = useState(false);
    const modalRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (visible) {
            loadFileTree();
        }
    }, [visible]);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
                onClose();
            }
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };

        if (visible) {
            document.addEventListener('mousedown', handleClickOutside);
            document.addEventListener('keydown', handleKeyDown);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [visible, onClose]);

    const loadFileTree = async () => {
        setLoading(true);
        try {
            // Request file tree from extension
            vscode.postMessage({
                command: 'getFileTree'
            });
        } catch (error) {
            console.error('Failed to load file tree:', error);
        } finally {
            setLoading(false);
        }
    };

    // Listen for file tree response
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            if (message.command === 'fileTree') {
                setTree(message.tree || []);
                setLoading(false);
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const toggleExpanded = (path: string) => {
        const newExpanded = new Set(expandedPaths);
        if (newExpanded.has(path)) {
            newExpanded.delete(path);
        } else {
            newExpanded.add(path);
        }
        setExpandedPaths(newExpanded);
    };

    const handleSelect = (node: FileTreeNode) => {
        onSelect(node.path, node.type);
        onClose();
    };

    const getFileIcon = (node: FileTreeNode): string => {
        if (node.type === 'directory') {
            return expandedPaths.has(node.path) ? '📂' : '📁';
        }

        // File icons based on extension
        const ext = node.name.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'js':
            case 'jsx':
                return '📄';
            case 'ts':
            case 'tsx':
                return '🔷';
            case 'py':
                return '🐍';
            case 'java':
                return '☕';
            case 'html':
                return '🌐';
            case 'css':
                return '🎨';
            case 'json':
                return '📋';
            case 'md':
                return '📝';
            case 'png':
            case 'jpg':
            case 'jpeg':
            case 'gif':
            case 'svg':
                return '🖼️';
            default:
                return '📄';
        }
    };

    const renderTreeNode = (node: FileTreeNode, level: number = 0): React.ReactNode => {
        const isExpanded = expandedPaths.has(node.path);
        const hasChildren = node.children && node.children.length > 0;

        return (
            <div key={node.path} className="file-tree-node">
                <div
                    className={`file-tree-item ${node.type}`}
                    style={{ paddingLeft: `${level * 16 + 8}px` }}
                    onClick={() => {
                        if (node.type === 'directory') {
                            toggleExpanded(node.path);
                        } else {
                            handleSelect(node);
                        }
                    }}
                    onDoubleClick={() => {
                        if (node.type === 'directory') {
                            handleSelect(node);
                        }
                    }}
                >
                    <div className="file-tree-item-content">
                        {node.type === 'directory' && (
                            <span className={`expand-icon ${isExpanded ? 'expanded' : ''}`}>
                                ▶
                            </span>
                        )}
                        <span className="file-icon">
                            {getFileIcon(node)}
                        </span>
                        <span className="file-name">{node.name}</span>
                        {node.type === 'directory' && (
                            <span className="select-directory-hint">
                                (double-click to select)
                            </span>
                        )}
                    </div>
                </div>
                {node.type === 'directory' && isExpanded && hasChildren && (
                    <div className="file-tree-children">
                        {node.children?.map(child => renderTreeNode(child, level + 1))}
                    </div>
                )}
            </div>
        );
    };

    if (!visible) {
        return null;
    }

    return (
        <div className="file-tree-modal-overlay">
            <div ref={modalRef} className="file-tree-modal">
                <div className="file-tree-header">
                    <h3>{title}</h3>
                    <button className="close-button" onClick={onClose}>×</button>
                </div>
                <div className="file-tree-content">
                    {loading ? (
                        <div className="loading-state">
                            <div className="loading-spinner">⏳</div>
                            <span>Loading file tree...</span>
                        </div>
                    ) : tree.length === 0 ? (
                        <div className="empty-state">
                            <span>No files found</span>
                        </div>
                    ) : (
                        <div className="file-tree-container">
                            {tree.map(node => renderTreeNode(node))}
                        </div>
                    )}
                </div>
                <div className="file-tree-footer">
                    <span className="file-tree-hint">
                        💡 Click files to select • Double-click directories to select
                    </span>
                </div>
            </div>
        </div>
    );
};

export default FileTreeBrowser; 