import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ContextMentionType, ContextSuggestion } from '../types/contextMentions';
import './ContextAwareInput.css';
import ContextDropdown from './ContextDropdown';
import FileTreeBrowser from './FileTreeBrowser';

// Declare vscode API
declare const vscode: any;

interface ContextAwareInputProps {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    disabled: boolean;
    placeholder?: string;
    suggestions?: ContextSuggestion[];
    attachedContexts?: any[]; // Add prop to track context chips
}

interface CursorPosition {
    start: number;
    end: number;
}

const ContextAwareInput: React.FC<ContextAwareInputProps> = ({
    value,
    onChange,
    onSubmit,
    disabled,
    placeholder = "Ask anything...",
    suggestions: externalSuggestions = [],
    attachedContexts = []
}) => {
    const [suggestions, setSuggestions] = useState<ContextSuggestion[]>([]);
    const [showDropdown, setShowDropdown] = useState(false);
    const [dropdownPosition, setDropdownPosition] = useState({ top: 0, left: 0 });
    const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
    const [showFileTree, setShowFileTree] = useState(false);
    const [currentMention, setCurrentMention] = useState('');
    const [mentionStartPos, setMentionStartPos] = useState(-1);

    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Auto-resize textarea
    const autoResize = useCallback(() => {
        const textarea = textareaRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
        }
    }, []);

    useEffect(() => {
        autoResize();
    }, [value, autoResize]);

    // Get cursor position
    const getCursorPosition = (): CursorPosition => {
        const textarea = textareaRef.current;
        if (!textarea) return { start: 0, end: 0 };
        return {
            start: textarea.selectionStart,
            end: textarea.selectionEnd
        };
    };

    // Set cursor position
    const setCursorPosition = (start: number, end?: number) => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.setSelectionRange(start, end ?? start);
        textarea.focus();
    };

    // Calculate dropdown position relative to input container
    const calculateDropdownPosition = useCallback((mentionStart: number) => {
        const textarea = textareaRef.current;
        if (!textarea) return { top: 0, left: 0 };

        // Position dropdown above the input with some spacing
        return {
            top: -(280 + 8), // Negative value to position above (dropdown height + gap)
            left: 0 // Align with left edge of input
        };
    }, []);

    // Parse @ mentions
    const findCurrentMention = useCallback((text: string, cursorPos: number) => {
        // Find @ symbol before cursor
        let atPos = cursorPos - 1;
        while (atPos >= 0 && text[atPos] !== '@' && text[atPos] !== ' ' && text[atPos] !== '\n') {
            atPos--;
        }

        if (atPos >= 0 && text[atPos] === '@') {
            const mention = text.substring(atPos + 1, cursorPos);
            return {
                mention,
                startPos: atPos,
                isValid: true
            };
        }

        return {
            mention: '',
            startPos: -1,
            isValid: false
        };
    }, []);

    // Get default suggestions
    const getDefaultSuggestions = useCallback((): ContextSuggestion[] => {
        return [
            {
                type: ContextMentionType.FILE,
                label: 'File',
                value: 'file',
                description: 'Select a specific file from your project',
                icon: '📄'
            },
            {
                type: ContextMentionType.DIRECTORY,
                label: 'Directory',
                value: 'directory',
                description: 'Select a directory from your project',
                icon: '📁'
            },
            {
                type: ContextMentionType.GIT,
                label: 'Git Context',
                value: 'git',
                description: 'Include git status, recent changes, or branch info',
                icon: '🌲'
            },
            {
                type: ContextMentionType.PROJECT,
                label: 'Project Structure',
                value: 'project',
                description: 'Include overall project structure and files',
                icon: '🏗️'
            },
            {
                type: ContextMentionType.WEB,
                label: 'Web Search',
                value: 'web',
                description: 'Include instructions for web search',
                icon: '🌐'
            }
        ];
    }, []);

    // Request suggestions from backend
    const requestSuggestions = useCallback(async (query: string) => {
        // Always request from backend for dynamic suggestions
        try {
            vscode.postMessage({
                command: 'getContextSuggestions',
                query: query,
                cursorPosition: getCursorPosition().start
            });
        } catch (error) {
            console.error('Failed to request suggestions:', error);

            // Fallback to default suggestions if backend fails
            const defaultSuggestions = getDefaultSuggestions();
            if (query.trim() === '') {
                setSuggestions(defaultSuggestions);
            } else {
                const filteredSuggestions = defaultSuggestions.filter(suggestion =>
                    suggestion.label.toLowerCase().includes(query.toLowerCase()) ||
                    suggestion.type.toLowerCase().includes(query.toLowerCase())
                );
                setSuggestions(filteredSuggestions);
            }
        }
    }, [getDefaultSuggestions]);

    // Handle input change
    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newValue = e.target.value;
        const cursorPos = getCursorPosition().start;

        onChange(newValue);

        // Check for @ mention
        const mentionInfo = findCurrentMention(newValue, cursorPos);

        if (mentionInfo.isValid) {
            setCurrentMention(mentionInfo.mention);
            setMentionStartPos(mentionInfo.startPos);

            // Request suggestions
            requestSuggestions(mentionInfo.mention);

            // Calculate and show dropdown
            const position = calculateDropdownPosition(mentionInfo.startPos);
            setDropdownPosition(position);
            setShowDropdown(true);
            setSelectedSuggestionIndex(0);
        } else {
            setShowDropdown(false);
            setCurrentMention('');
            setMentionStartPos(-1);
        }
    }, [onChange, findCurrentMention, requestSuggestions, calculateDropdownPosition]);

    // Handle suggestion selection
    const handleSuggestionSelect = useCallback((suggestion: ContextSuggestion) => {
        if (mentionStartPos === -1) return;

        if (suggestion.type === ContextMentionType.FILE || suggestion.type === ContextMentionType.DIRECTORY) {
            // Show file tree for file/directory selection
            setShowFileTree(true);
            setShowDropdown(false);
            return;
        }

        // For other context types (git, project, web), create the mention and notify parent
        const mentionText = `@${suggestion.value}`;
        const beforeMention = value.substring(0, mentionStartPos);
        const afterMention = value.substring(mentionStartPos + currentMention.length + 1);
        const newValue = beforeMention + mentionText + ' ' + afterMention;

        onChange(newValue);
        setShowDropdown(false);

        // Notify parent component about context selection
        // We'll use a custom event for now since we don't have a direct callback
        const contextEvent = new CustomEvent('contextSelected', {
            detail: {
                type: suggestion.type,
                display: suggestion.label,
                originalMention: mentionText,
                description: suggestion.description
            }
        });
        window.dispatchEvent(contextEvent);

        // Set cursor position after the inserted text
        setTimeout(() => {
            const newCursorPos = beforeMention.length + mentionText.length + 1;
            setCursorPosition(newCursorPos);
        }, 0);
    }, [value, currentMention, mentionStartPos, onChange]);

    // Handle file tree selection
    const handleFileTreeSelect = useCallback((path: string, type: 'file' | 'directory') => {
        if (mentionStartPos === -1) return;

        const mention = type === 'directory' ? `@${path}/` : `@${path}`;
        const beforeMention = value.substring(0, mentionStartPos);
        const afterMention = value.substring(mentionStartPos + currentMention.length + 1);
        const newValue = beforeMention + mention + ' ' + afterMention;

        onChange(newValue);
        setShowFileTree(false);

        // Set cursor position after the inserted text
        setTimeout(() => {
            const newCursorPos = beforeMention.length + mention.length + 1;
            setCursorPosition(newCursorPos);
        }, 0);
    }, [value, currentMention, mentionStartPos, onChange]);

    // Handle keyboard navigation
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (showDropdown && suggestions.length > 0) {
            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    setSelectedSuggestionIndex(prev =>
                        prev < suggestions.length - 1 ? prev + 1 : 0
                    );
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    setSelectedSuggestionIndex(prev =>
                        prev > 0 ? prev - 1 : suggestions.length - 1
                    );
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (selectedSuggestionIndex >= 0 && selectedSuggestionIndex < suggestions.length) {
                        handleSuggestionSelect(suggestions[selectedSuggestionIndex]);
                    }
                    break;
                case 'Escape':
                    e.preventDefault();
                    setShowDropdown(false);
                    break;
            }
        } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();

            // Always submit the original query with @ symbols preserved
            // Don't clean context mentions from the query
            onSubmit();
        }
    }, [showDropdown, suggestions, selectedSuggestionIndex, handleSuggestionSelect, onSubmit]);

    // Update suggestions when external suggestions change
    useEffect(() => {
        console.log('[ContextAwareInput] External suggestions updated:', externalSuggestions);
        setSuggestions(externalSuggestions);
    }, [externalSuggestions]);

    return (
        <div className="context-aware-input-container">
            <div className="input-wrapper">
                <textarea
                    ref={textareaRef}
                    className="message-input context-aware"
                    placeholder={placeholder}
                    value={value}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    disabled={disabled}
                    rows={1}
                />


            </div>

            {/* Context dropdown */}
            <ContextDropdown
                suggestions={suggestions}
                visible={showDropdown}
                position={dropdownPosition}
                onSelect={handleSuggestionSelect}
                onClose={() => setShowDropdown(false)}
                selectedIndex={selectedSuggestionIndex}
            />

            {/* File tree browser */}
            <FileTreeBrowser
                visible={showFileTree}
                onSelect={handleFileTreeSelect}
                onClose={() => setShowFileTree(false)}
            />
        </div>
    );
};

export default ContextAwareInput; 