import * as THREE from 'three';

// Constants
const GRID_WIDTH = 10;
const GRID_HEIGHT = 20;
const BLOCK_SIZE = 1;

// Scene Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050505);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(GRID_WIDTH / 2, GRID_HEIGHT / 2, 30);
camera.lookAt(GRID_WIDTH / 2, GRID_HEIGHT / 2, 0);

const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambientLight);

const pointLight = new THREE.PointLight(0xffffff, 1);
pointLight.position.set(GRID_WIDTH / 2, GRID_HEIGHT / 2, 20);
scene.add(pointLight);

// Game State
let grid = Array.from({ length: GRID_HEIGHT }, () => Array(GRID_WIDTH).fill(null));
let currentPiece = null;
let score = 0;
let gameOver = false;
let dropCounter = 0;
let dropInterval = 1000;
let lastTime = 0;

const PIECES = {
    'I': [[1, 1, 1, 1]],
    'J': [[1, 0, 0], [1, 1, 1]],
    'L': [[0, 0, 1], [1, 1, 1]],
    'O': [[1, 1], [1, 1]],
    'S': [[0, 1, 1], [1, 1, 0]],
    'T': [[0, 1, 0], [1, 1, 1]],
    'Z': [[1, 1, 0], [0, 1, 1]]
};

const COLORS = {
    'I': 0x00f0f0,
    'J': 0x0000f0,
    'L': 0xf0a000,
    'O': 0xf0f000,
    'S': 0x00f000,
    'T': 0xa000f0,
    'Z': 0xf00000
};

let staticBlocks = [];

function createPiece() {
    const keys = Object.keys(PIECES);
    const type = keys[Math.floor(Math.random() * keys.length)];
    const shape = PIECES[type];
    const color = COLORS[type];

    const meshes = [];
    shape.forEach((row, y) => {
        row.forEach((val, x) => {
            if (val) {
                const geometry = new THREE.BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
                const material = new THREE.MeshStandardMaterial({ color: color });
                const mesh = new THREE.Mesh(geometry, material);
                meshes.push(mesh);
            }
        });
    });

    const piece = {
        shape,
        type,
        color,
        x: Math.floor(GRID_WIDTH / 2) - Math.floor(shape[0].length / 2),
        y: GRID_HEIGHT - 2,
        meshes,
        group: new THREE.Group()
    };

    meshes.forEach(m => {
        piece.group.add(m);
        m.position.set(0, 0, 0); // Relative to group
    });

    scene.add(piece.group);
    // Set initial absolute position
    piece.group.position.set(piece.x, piece.y, 0);
    
    return piece;
}

function init() {
    currentPiece = createPiece();
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', onWindowResize);

    requestAnimationFrame(animate);
}

function handleKeyDown(e) {
    if (gameOver) return;
    
    switch(e.key) {
        case 'ArrowLeft':
            movePiece(-1, 0);
            break;
        case 'ArrowRight':
            movePiece(1, 0);
            break;
        case 'ArrowDown':
            drop();
            break;
        case 'ArrowUp':
            rotatePiece();
            break;
    }
}

function movePiece(dx, dy) {
    if (isValidPosition(currentPiece.x + dx, currentPiece.y + dy)) {
        currentPiece.x += dx;
        currentPiece.y += dy;
        currentPiece.group.position.set(currentPiece.x, currentPiece.y, 0);
        return true;
    }
    return false;
}

function rotatePiece() {
    const newShape = currentPiece.shape[0].map((_, index) => currentPiece.shape.map(row => row[index]).reverse());
    const oldShape = currentPiece.shape;
    currentPiece.shape = newShape;

    if (!isValidPosition(currentPiece.x, currentPiece.y)) {
        currentPiece.shape = oldShape;
    } else {
        // Update internal mesh positions relative to group
        currentPiece.meshes.forEach((m, i) => {
            const shapeIdx = i % currentPiece.shape.length;
            const shape_x = i % currentPiece.shape[shapeIdx].length;
            // This is getting complex, let's just re-render the group
            // Actually, just updating the group position is enough if we handle the meshes correctly
        });
        // Easier way: just re-calculate mesh positions relative to group center
        // But for Tetris, we can just update the shape and check collision
        // And since rotation happens around a pivot, we might need to adjust x/y
    }
}

// Let's simplify rotation: it's a 2D rotation.
function rotatePieceSimplified() {
    const oldShape = currentPiece.shape;
    const newShape = oldShape[0].map((_, index) => oldShape.map(row => row[index]).reverse());
    
    // Temporary move to check collision
    if (isValidPosition(currentPiece.x, currentPiece.y)) {
        // Need to calculate new mesh positions
        // This is why I should have used a simpler approach
    }
}

// Let's rethink. For Three.js, it's often easier to just have a pool of blocks 
// or just clear and redraw.

function isValidPosition(x, y) {
    for (let i = 0; i < currentPiece.shape.length; i++) {
        for (let j = 0; j < currentPiece.shape[i].length; j++) {
            if (currentPiece.shape[i][j]) {
                const gridX = x + j;
                const gridY = y + i;
                if (gridY < 0 || gridY >= GRID_HEIGHT || gridX < 0 || gridX >= GRID_WIDTH || (gridY >= 0 && grid[gridY][gridX])) {
                    return false;
                }
            }
        }
    }
    return true;
}

function drop() {
    if (movePiece(0, 1)) {
        // Do nothing, movePiece already updated position
    } else {
        lockPiece();
        currentPiece = createPiece();
        if (!isValidPosition(currentPiece.x, currentPiece.y)) {
            gameOver = true;
            document.getElementById('game-over').style.display = 'block';
        }
    }
}

// Actually, the animate function already handles the time.
// I'll fix the drop logic.
