import React from 'react';
import { ContextChipsProps, ContextMentionType } from '../types/contextMentions';
import './ContextChips.css';

const ContextChips: React.FC<ContextChipsProps> = ({ contexts, onRemove }) => {
    if (contexts.length === 0) {
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
        <div className="context-chips-container">
            <div className="context-chips-header">
                <span className="context-chips-label">📎 Attached Context:</span>
            </div>
            <div className="context-chips-list">
                {contexts.map((context) => (
                    <div
                        key={context.id}
                        className="context-chip"
                        style={{
                            borderColor: getTypeColor(context.type),
                            backgroundColor: `${getTypeColor(context.type)}15`
                        }}
                    >
                        <span className="context-chip-icon">
                            {getIcon(context.type)}
                        </span>
                        <span className="context-chip-display">
                            {context.display}
                        </span>
                        <span className="context-chip-description">
                            {context.description}
                        </span>
                        <button
                            className="context-chip-remove"
                            onClick={() => onRemove(context.id)}
                            title="Remove context"
                        >
                            ×
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default ContextChips; 