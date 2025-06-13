import React, { useEffect, useRef } from 'react';
import { ContextDropdownProps, ContextMentionType } from '../types/contextMentions';
import './ContextDropdown.css';

const ContextDropdown: React.FC<ContextDropdownProps> = ({
    suggestions,
    visible,
    position,
    onSelect,
    onClose,
    selectedIndex
}) => {
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                onClose();
            }
        };

        if (visible) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [visible, onClose]);

    if (!visible || suggestions.length === 0) {
        return null;
    }

    const getIcon = (type: ContextMentionType): string => {
        switch (type) {
            case ContextMentionType.FILE:
                return '📄';
            case ContextMentionType.DIRECTORY:
                return '📁';
            case ContextMentionType.GIT:
                return '🌲';
            case ContextMentionType.PROJECT:
                return '🏗️';
            case ContextMentionType.WEB:
                return '🌐';
            default:
                return '📄';
        }
    };

    const getTypeColor = (type: ContextMentionType): string => {
        switch (type) {
            case ContextMentionType.FILE:
                return '#007acc';
            case ContextMentionType.DIRECTORY:
                return '#ffa500';
            case ContextMentionType.GIT:
                return '#28a745';
            case ContextMentionType.PROJECT:
                return '#6f42c1';
            case ContextMentionType.WEB:
                return '#dc3545';
            default:
                return '#6c757d';
        }
    };

    return (
        <div
            ref={dropdownRef}
            className="context-dropdown"
            style={{
                top: position.top,
                left: position.left
            }}
        >
            <div className="context-dropdown-header">
                <span className="context-dropdown-title">Select Context</span>
                <span className="context-dropdown-hint">↑↓ navigate • Enter select • Esc close</span>
            </div>
            <div className="context-dropdown-list">
                {suggestions.map((suggestion, index) => (
                    <div
                        key={`${suggestion.type}-${suggestion.value}`}
                        className={`context-dropdown-item ${index === selectedIndex ? 'selected' : ''}`}
                        onClick={() => onSelect(suggestion)}
                        style={{
                            borderLeftColor: getTypeColor(suggestion.type)
                        }}
                    >
                        <div className="context-item-icon">
                            {getIcon(suggestion.type)}
                        </div>
                        <div className="context-item-content">
                            <div className="context-item-display">{suggestion.label || 'Unknown'}</div>
                            <div className="context-item-description">{suggestion.description || ''}</div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default ContextDropdown; 