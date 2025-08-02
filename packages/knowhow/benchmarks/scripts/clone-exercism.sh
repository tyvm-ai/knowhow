#!/bin/bash

# Clone Exercism exercises for benchmarking
# Based on Aider's clone-exercism.sh approach

set -e

# Configuration
EXERCISM_REPO="https://github.com/exercism/problem-specifications.git"
LANGUAGE=${1:-"javascript"}  # Default to JavaScript
MAX_EXERCISES=${2:-10}       # Default to 10 exercises

# Use different paths for local vs container
if [ -n "$CONTAINER" ]; then
    EXERCISES_DIR="/app/exercises"
else
    EXERCISES_DIR="$(cd "$(dirname "$0")/.." && pwd)/exercises"
fi

echo "Cloning Exercism exercises for language: $LANGUAGE"
echo "Maximum exercises: $MAX_EXERCISES"
echo "Target directory: $EXERCISES_DIR"

# Create exercises directory if it doesn't exist
mkdir -p "$EXERCISES_DIR"

# Clone the problem specifications repo if not already cloned
if [ ! -d "$EXERCISES_DIR/problem-specifications" ]; then
    echo "Cloning Exercism problem specifications..."
    cd "$EXERCISES_DIR"
    git clone "$EXERCISM_REPO" problem-specifications
fi

# Clone the language track
LANGUAGE_REPO="https://github.com/exercism/${LANGUAGE}.git"
LANGUAGE_DIR="$EXERCISES_DIR/$LANGUAGE"

if [ ! -d "$LANGUAGE_DIR" ]; then
    echo "Cloning $LANGUAGE track..."
    cd "$EXERCISES_DIR"
    git clone "$LANGUAGE_REPO" "$LANGUAGE"
fi

# Find exercises with both problem specification and language implementation
echo "Finding exercises with both specification and implementation..."

SPEC_DIR="$EXERCISES_DIR/problem-specifications/exercises"
IMPL_DIR="$LANGUAGE_DIR/exercises"

# Create filtered exercises directory
FILTERED_DIR="$EXERCISES_DIR/filtered"
mkdir -p "$FILTERED_DIR"

count=0
for exercise in $(ls "$SPEC_DIR" 2>/dev/null | sort); do
    if [ $count -ge $MAX_EXERCISES ]; then
        break
    fi
    
    if [ -d "$IMPL_DIR/practice/$exercise" ] || [ -d "$IMPL_DIR/$exercise" ]; then
        echo "Found exercise: $exercise"
        
        # Create exercise directory
        exercise_dir="$FILTERED_DIR/$exercise"
        mkdir -p "$exercise_dir"
        
        # Copy problem specification
        if [ -f "$SPEC_DIR/$exercise/description.md" ]; then
            cp "$SPEC_DIR/$exercise/description.md" "$exercise_dir/"
        fi
        
        if [ -f "$SPEC_DIR/$exercise/metadata.yml" ]; then
            cp "$SPEC_DIR/$exercise/metadata.yml" "$exercise_dir/"
        fi
        
        # Copy language implementation
        if [ -d "$IMPL_DIR/practice/$exercise" ]; then
            cp -r "$IMPL_DIR/practice/$exercise"/* "$exercise_dir/"
        elif [ -d "$IMPL_DIR/$exercise" ]; then
            cp -r "$IMPL_DIR/$exercise"/* "$exercise_dir/"
        fi
        
        count=$((count + 1))
    fi
done

echo "Successfully set up $count exercises in $FILTERED_DIR"
echo "Ready for benchmarking!"